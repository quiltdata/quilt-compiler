import concurrent
import functools
import hashlib
import itertools
import logging
import math
import os
import pathlib
import queue
import shutil
import stat
import threading
import types
import warnings
from codecs import iterdecode
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from enum import Enum
from threading import Lock
from typing import List, Tuple

import boto3
import jsonlines
from boto3.s3.transfer import TransferConfig
from botocore import UNSIGNED
from botocore.client import Config
from botocore.exceptions import (
    ClientError,
    ConnectionError,
    HTTPClientError,
    ReadTimeoutError,
)
from s3transfer.utils import (
    ChunksizeAdjuster,
    OSUtils,
    signal_not_transferring,
    signal_transferring,
)
from tenacity import (
    retry,
    retry_if_not_result,
    retry_if_result,
    stop_after_attempt,
    wait_exponential,
)
from tqdm import tqdm

from .session import create_botocore_session
from .util import DISABLE_TQDM, PhysicalKey, QuiltException

MAX_COPY_FILE_LIST_RETRIES = 3
MAX_FIX_HASH_RETRIES = 3


logger = logging.getLogger(__name__)


class S3Api(Enum):
    GET_OBJECT = "GET_OBJECT"
    HEAD_OBJECT = "HEAD_OBJECT"
    LIST_OBJECT_VERSIONS = "LIST_OBJECT_VERSIONS"
    LIST_OBJECTS_V2 = "LIST_OBJECTS_V2"


class S3NoValidClientError(Exception):
    def __init__(self, message, **kwargs):
        # We use NewError("Prefix: " + str(error)) a lot.
        # To be consistent across Python 2.7 and 3.x:
        # 1) This `super` call must exist, or 2.7 will have no text for str(error)
        # 2) This `super` call must have only one argument (the message) or str(error) will be a repr of args
        super().__init__(message)
        self.message = message
        for k, v in kwargs.items():
            setattr(self, k, v)


class S3ClientProvider:
    """
    An s3_client is either signed with standard credentials or unsigned. This class exists to dynamically provide the
    correct s3 client (either standard_client or unsigned_client) for a bucket. This means if standard credentials
    can't read from the bucket, check if the bucket is public in which case we should be using an unsigned client.
    This check is expensive at scale so the class also keeps track of which client to use for each bucket+api_call.

    If there are no credentials available at all (i.e. you don't have AWS credentials and you don't have a
    Quilt-provided role from quilt3.login()), the standard client will also be unsigned so that users can still
    access public s3 buckets.

    We assume that public buckets are read-only: write operations should always use S3ClientProvider.standard_client
    """

    def __init__(self):
        self._use_unsigned_client = {}  # f'{action}/{bucket}' -> use_unsigned_client_bool
        self._standard_client = None
        self._unsigned_client = None

    @property
    def standard_client(self):
        if self._standard_client is None:
            self._build_standard_client()
        return self._standard_client

    @property
    def unsigned_client(self):
        if self._unsigned_client is None:
            self._build_unsigned_client()
        return self._unsigned_client

    def get_correct_client(self, action: S3Api, bucket: str):
        if not self.client_type_known(action, bucket):
            raise RuntimeError("get_correct_client was called, but the correct client type is not known. Only call "
                               "get_correct_client() after checking if client_type_known()")

        if self.should_use_unsigned_client(action, bucket):
            return self.unsigned_client
        else:
            return self.standard_client

    def key(self, action: S3Api, bucket: str):
        return f"{action}/{bucket}"

    def set_cache(self, action: S3Api, bucket: str, use_unsigned: bool):
        self._use_unsigned_client[self.key(action, bucket)] = use_unsigned

    def should_use_unsigned_client(self, action: S3Api, bucket: str):
        # True if should use unsigned, False if should use standard, None if don't know yet
        return self._use_unsigned_client.get(self.key(action, bucket))

    def client_type_known(self, action: S3Api, bucket: str):
        return self.should_use_unsigned_client(action, bucket) is not None

    def find_correct_client(self, api_type, bucket, param_dict):
        if self.client_type_known(api_type, bucket):
            return self.get_correct_client(api_type, bucket)
        else:
            check_fn_mapper = {
                S3Api.GET_OBJECT: check_get_object_works_for_client,
                S3Api.HEAD_OBJECT: check_head_object_works_for_client,
                S3Api.LIST_OBJECTS_V2: check_list_objects_v2_works_for_client,
                S3Api.LIST_OBJECT_VERSIONS: check_list_object_versions_works_for_client
            }
            assert api_type in check_fn_mapper.keys(), f"Only certain APIs are supported with unsigned_client. The " \
                f"API '{api_type}' is not current supported. You may want to use S3ClientProvider.standard_client " \
                f"instead "
            check_fn = check_fn_mapper[api_type]
            if check_fn(self.standard_client, param_dict):
                self.set_cache(api_type, bucket, use_unsigned=False)
                return self.standard_client
            else:
                if check_fn(self.unsigned_client, param_dict):
                    self.set_cache(api_type, bucket, use_unsigned=True)
                    return self.unsigned_client
                else:
                    raise S3NoValidClientError(f"S3 AccessDenied for {api_type} on bucket: {bucket}")

    def get_boto_session(self):
        botocore_session = create_botocore_session()
        boto_session = boto3.Session(botocore_session=botocore_session)
        return boto_session

    def register_signals(self, s3_client):
        # Enable/disable file read callbacks when uploading files.
        # Copied from https://github.com/boto/s3transfer/blob/develop/s3transfer/manager.py#L501
        event_name = 'request-created.s3'
        s3_client.meta.events.register_first(
                event_name, signal_not_transferring,
                unique_id='datatransfer-not-transferring')
        s3_client.meta.events.register_last(
                event_name, signal_transferring,
                unique_id='datatransfer-transferring')

    def _build_client(self, get_config):
        session = self.get_boto_session()
        return session.client('s3', config=get_config(session))

    def _build_standard_client(self):
        s3_client = self._build_client(
            lambda session:
                Config(signature_version=UNSIGNED)
                if session.get_credentials() is None
                else None
        )
        self.register_signals(s3_client)
        self._standard_client = s3_client

    def _build_unsigned_client(self):
        s3_client = self._build_client(lambda session: Config(signature_version=UNSIGNED))
        self.register_signals(s3_client)
        self._unsigned_client = s3_client


def check_list_object_versions_works_for_client(s3_client, params):
    try:
        s3_client.list_object_versions(**params, MaxKeys=1)  # Make this as fast as possible
    except ClientError as e:
        return e.response["Error"]["Code"] != "AccessDenied"
    return True


def check_list_objects_v2_works_for_client(s3_client, params):
    try:
        s3_client.list_objects_v2(**params, MaxKeys=1)  # Make this as fast as possible
    except ClientError as e:
        if e.response["Error"]["Code"] == "AccessDenied":
            return False
    return True


def check_get_object_works_for_client(s3_client, params):
    try:
        head_args = dict(
                Bucket=params["Bucket"],
                Key=params["Key"]
        )
        if "VersionId" in params:
            head_args["VersionId"] = params["VersionId"]

        s3_client.head_object(**head_args)  # HEAD/GET share perms, but HEAD always fast
    except ClientError as e:
        if e.response["Error"]["Code"] == "403":
            # This can also happen if you have full get_object access, but not list_objects_v2, and the object does not
            # exist. Instead of returning a 404, S3 will return a 403.
            return False

    return True


def check_head_object_works_for_client(s3_client, params):
    try:
        s3_client.head_object(**params)
    except ClientError as e:
        if e.response["Error"]["Code"] == "403":
            # This can also happen if you have full get_object access, but not list_objects_v2, and the object does not
            # exist. Instead of returning a 404, S3 will return a 403.
            return False
    return True


s3_transfer_config = TransferConfig()


def read_file_chunks(file, chunksize=s3_transfer_config.io_chunksize):
    return itertools.takewhile(bool, map(file.read, itertools.repeat(chunksize)))


# When uploading files at least this size, compare the ETags first and skip the upload if they're equal;
# copy the remote file onto itself if the metadata changes.
UPLOAD_ETAG_OPTIMIZATION_THRESHOLD = 1024


def _copy_local_file(ctx, size, src_path, dest_path):
    pathlib.Path(dest_path).parent.mkdir(parents=True, exist_ok=True)

    # TODO(dima): More detailed progress.
    shutil.copyfile(src_path, dest_path)
    ctx.progress(size)
    shutil.copymode(src_path, dest_path)

    ctx.done(PhysicalKey.from_path(dest_path))


def _upload_file(ctx, size, src_path, dest_bucket, dest_key):
    s3_client = ctx.s3_client_provider.standard_client

    if size < s3_transfer_config.multipart_threshold:
        with OSUtils().open_file_chunk_reader(src_path, 0, size, [ctx.progress]) as fd:
            resp = s3_client.put_object(
                Body=fd,
                Bucket=dest_bucket,
                Key=dest_key,
            )

        version_id = resp.get('VersionId')  # Absent in unversioned buckets.
        ctx.done(PhysicalKey(dest_bucket, dest_key, version_id))
    else:
        resp = s3_client.create_multipart_upload(
            Bucket=dest_bucket,
            Key=dest_key,
        )
        upload_id = resp['UploadId']

        adjuster = ChunksizeAdjuster()
        chunksize = adjuster.adjust_chunksize(s3_transfer_config.multipart_chunksize, size)

        chunk_offsets = list(range(0, size, chunksize))

        lock = Lock()
        remaining = len(chunk_offsets)
        parts = [None] * remaining

        def upload_part(i, start, end):
            nonlocal remaining
            part_id = i + 1
            with OSUtils().open_file_chunk_reader(src_path, start, end-start, [ctx.progress]) as fd:
                part = s3_client.upload_part(
                    Body=fd,
                    Bucket=dest_bucket,
                    Key=dest_key,
                    UploadId=upload_id,
                    PartNumber=part_id
                )
            with lock:
                parts[i] = {"PartNumber": part_id, "ETag": part["ETag"]}
                remaining -= 1
                done = remaining == 0

            if done:
                resp = s3_client.complete_multipart_upload(
                    Bucket=dest_bucket,
                    Key=dest_key,
                    UploadId=upload_id,
                    MultipartUpload={"Parts": parts}
                )
                version_id = resp.get('VersionId')  # Absent in unversioned buckets.
                ctx.done(PhysicalKey(dest_bucket, dest_key, version_id))

        for i, start in enumerate(chunk_offsets):
            end = min(start + chunksize, size)
            ctx.run(upload_part, i, start, end)


def _download_file(ctx, size, src_bucket, src_key, src_version, dest_path):
    dest_file = pathlib.Path(dest_path)
    if dest_file.is_reserved():
        raise ValueError("Cannot download to %r: reserved file name" % dest_path)

    params = dict(Bucket=src_bucket, Key=src_key)
    s3_client = ctx.s3_client_provider.find_correct_client(S3Api.GET_OBJECT, src_bucket, params)

    dest_file.parent.mkdir(parents=True, exist_ok=True)

    with dest_file.open('wb') as f:
        fileno = f.fileno()
        is_regular_file = stat.S_ISREG(os.stat(fileno).st_mode)

        # TODO: To enable this we need to fix some tests in test_packages,
        #       that setup mocked responses to return less data than expected/specified in the manifest.
        # if is_regular_file:
        #     # Preallocate file.
        #     if hasattr(os, 'posix_fallocate'):
        #         os.posix_fallocate(fileno, 0, size)
        #     else:
        #         f.truncate(size)

    if src_version is not None:
        params.update(VersionId=src_version)

    part_size = s3_transfer_config.multipart_chunksize
    is_multi_part = (
        is_regular_file
        and size >= s3_transfer_config.multipart_threshold
        and size > part_size
    )
    part_numbers = (
        range(math.ceil(size / part_size))
        if is_multi_part else
        (None,)
    )
    remaining_counter = len(part_numbers)
    remaining_counter_lock = Lock()

    def download_part(part_number):
        nonlocal remaining_counter

        with dest_file.open('r+b') as chunk_f:
            if part_number is not None:
                start = part_number * part_size
                end = min(start + part_size, size) - 1
                part_params = dict(params, Range=f'bytes={start}-{end}')
                chunk_f.seek(start)
            else:
                part_params = params

            resp = s3_client.get_object(**part_params)
            body = resp['Body']
            while True:
                chunk = body.read(s3_transfer_config.io_chunksize)
                if not chunk:
                    break
                ctx.progress(chunk_f.write(chunk))

        with remaining_counter_lock:
            remaining_counter -= 1
            done = remaining_counter == 0
        if done:
            ctx.done(PhysicalKey.from_path(dest_path))

    for part_number in part_numbers:
        ctx.run(download_part, part_number)


def _copy_remote_file(ctx, size, src_bucket, src_key, src_version,
                      dest_bucket, dest_key, extra_args=None):
    src_params = dict(
        Bucket=src_bucket,
        Key=src_key
    )
    if src_version is not None:
        src_params.update(
            VersionId=src_version
        )

    s3_client = ctx.s3_client_provider.standard_client

    if size < s3_transfer_config.multipart_threshold:
        params = dict(
            CopySource=src_params,
            Bucket=dest_bucket,
            Key=dest_key,
        )

        if extra_args:
            params.update(extra_args)

        resp = s3_client.copy_object(**params)
        ctx.progress(size)
        version_id = resp.get('VersionId')  # Absent in unversioned buckets.
        ctx.done(PhysicalKey(dest_bucket, dest_key, version_id))
    else:
        resp = s3_client.create_multipart_upload(
            Bucket=dest_bucket,
            Key=dest_key,
        )
        upload_id = resp['UploadId']

        adjuster = ChunksizeAdjuster()
        chunksize = adjuster.adjust_chunksize(s3_transfer_config.multipart_chunksize, size)

        chunk_offsets = list(range(0, size, chunksize))

        lock = Lock()
        remaining = len(chunk_offsets)
        parts = [None] * remaining

        def upload_part(i, start, end):
            nonlocal remaining
            part_id = i + 1
            part = s3_client.upload_part_copy(
                CopySource=src_params,
                CopySourceRange=f'bytes={start}-{end-1}',
                Bucket=dest_bucket,
                Key=dest_key,
                UploadId=upload_id,
                PartNumber=part_id
            )
            with lock:
                parts[i] = {"PartNumber": part_id, "ETag": part["CopyPartResult"]["ETag"]}
                remaining -= 1
                done = remaining == 0

            ctx.progress(end - start)

            if done:
                resp = s3_client.complete_multipart_upload(
                    Bucket=dest_bucket,
                    Key=dest_key,
                    UploadId=upload_id,
                    MultipartUpload={"Parts": parts}
                )
                version_id = resp.get('VersionId')  # Absent in unversioned buckets.
                ctx.done(PhysicalKey(dest_bucket, dest_key, version_id))

        for i, start in enumerate(chunk_offsets):
            end = min(start + chunksize, size)
            ctx.run(upload_part, i, start, end)


def _upload_or_copy_file(ctx, size, src_path, dest_bucket, dest_path):
    # Optimization: check if the remote file already exists and has the right ETag,
    # and skip the upload.
    if size >= UPLOAD_ETAG_OPTIMIZATION_THRESHOLD:
        try:
            params = dict(Bucket=dest_bucket, Key=dest_path)
            s3_client = ctx.s3_client_provider.find_correct_client(S3Api.HEAD_OBJECT, dest_bucket, params)
            resp = s3_client.head_object(**params)
        except ClientError:
            # Destination doesn't exist, so fall through to the normal upload.
            pass
        except S3NoValidClientError:
            # S3ClientProvider can't currently distinguish between a user that has PUT but not LIST permissions and a
            # user that has no permissions. If we can't find a valid client, proceed to the upload stage anyway.
            pass
        else:
            # Check the ETag.
            dest_size = resp['ContentLength']
            dest_etag = resp['ETag']
            dest_version_id = resp.get('VersionId')
            if size == dest_size:
                src_etag = _calculate_etag(src_path)
                if src_etag == dest_etag:
                    # Nothing more to do. We should not attempt to copy the object because
                    # that would cause the "copy object to itself" error.
                    ctx.progress(size)
                    ctx.done(PhysicalKey(dest_bucket, dest_path, dest_version_id))
                    return  # Optimization succeeded.

    # If the optimization didn't happen, do the normal upload.
    _upload_file(ctx, size, src_path, dest_bucket, dest_path)


class WorkerContext:
    def __init__(self, s3_client_provider, progress, done, run):
        self.s3_client_provider = s3_client_provider
        self.progress = progress
        self.done = done
        self.run = run


def _copy_file_list_last_retry(retry_state):
    return retry_state.fn(
        *retry_state.args,
        **{**retry_state.kwargs, 'exceptions_to_ignore': ()},
    )


@retry(stop=stop_after_attempt(MAX_COPY_FILE_LIST_RETRIES - 1),
       wait=wait_exponential(multiplier=1, min=1, max=10),
       retry=retry_if_not_result(all),
       retry_error_callback=_copy_file_list_last_retry)
def _copy_file_list_internal(file_list, results, message, callback, exceptions_to_ignore=(ClientError,)):
    """
    Takes a list of tuples (src, dest, size) and copies the data in parallel.
    `results` is the list where results will be stored.
    Returns versioned URLs for S3 destinations and regular file URLs for files.
    """
    if not file_list:
        return []

    assert len(file_list) == len(results)

    total_size = sum(size for (_, _, size), result in zip(file_list, results) if result is None)

    lock = Lock()
    futures = deque()
    future_to_idx = {}
    idx_to_futures = defaultdict(list)

    stopped = False

    s3_client_provider = S3ClientProvider()  # Share provider across threads to reduce redundant public bucket checks

    with tqdm(desc=message, total=total_size, unit='B', unit_scale=True, disable=DISABLE_TQDM) as progress, \
         ThreadPoolExecutor(s3_transfer_config.max_request_concurrency) as executor:

        def progress_callback(bytes_transferred):
            if stopped:
                raise Exception("Interrupted")
            with lock:
                progress.update(bytes_transferred)

        def run_task(idx, func, *args):
            future = executor.submit(func, *args)
            with lock:
                futures.append(future)
                future_to_idx[future] = idx
                idx_to_futures[idx].append(future)

        def worker(idx, src, dest, size):
            if stopped:
                raise Exception("Interrupted")

            def done_callback(value):
                assert value is not None
                with lock:
                    assert results[idx] is None
                    results[idx] = value
                if callback is not None:
                    callback(src, dest, size)

            ctx = WorkerContext(s3_client_provider=s3_client_provider,
                                progress=progress_callback,
                                done=done_callback,
                                run=functools.partial(run_task, idx))

            if dest.version_id:
                raise ValueError("Cannot set VersionId on destination")

            if src.is_local():
                if dest.is_local():
                    _copy_local_file(ctx, size, src.path, dest.path)
                else:
                    if dest.version_id:
                        raise ValueError("Cannot set VersionId on destination")
                    _upload_or_copy_file(ctx, size, src.path, dest.bucket, dest.path)
            else:
                if dest.is_local():
                    _download_file(ctx, size, src.bucket, src.path, src.version_id, dest.path)
                else:
                    _copy_remote_file(ctx, size, src.bucket, src.path, src.version_id,
                                      dest.bucket, dest.path)

        try:
            for idx, (args, result) in enumerate(zip(file_list, results)):
                if result is not None:
                    continue
                run_task(idx, worker, idx, *args)

            # ThreadPoolExecutor does not appear to have a way to just wait for everything to complete.
            # Shutting it down will cause it to wait - but will prevent any new tasks from starting.
            # So, manually wait for all tasks to complete.
            # This will also raise any exception that happened in a worker thread.
            while True:
                with lock:
                    if not futures:
                        break
                    future = futures.popleft()
                if future.cancelled():
                    continue
                try:
                    future.result()
                except exceptions_to_ignore:
                    with lock:
                        idx = future_to_idx[future]
                        futures_to_cancel = idx_to_futures[idx]
                        for f in futures_to_cancel:
                            f.cancel()
                        futures_to_cancel.clear()
        finally:
            # Make sure all tasks exit quickly if the main thread exits before they're done.
            stopped = True

    return results


def _calculate_etag(file_path):
    """
    Attempts to calculate a local file's ETag the way S3 does:
    - Normal uploads: MD5 of the file
    - Multi-part uploads: MD5 of the (binary) MD5s of the parts, dash, number of parts
    We can't know how the file was actually uploaded - but we're assuming it was done using
    the default settings, which we get from `s3_transfer_config`.
    """
    size = pathlib.Path(file_path).stat().st_size
    with open(file_path, 'rb') as fd:
        if size <= s3_transfer_config.multipart_threshold:
            contents = fd.read()
            etag = hashlib.md5(contents).hexdigest()
        else:
            adjuster = ChunksizeAdjuster()
            chunksize = adjuster.adjust_chunksize(s3_transfer_config.multipart_chunksize, size)

            hashes = []
            for contents in read_file_chunks(fd, chunksize):
                hashes.append(hashlib.md5(contents).digest())
            etag = '%s-%d' % (hashlib.md5(b''.join(hashes)).hexdigest(), len(hashes))
    return '"%s"' % etag


def delete_object(bucket, key):
    s3_client = S3ClientProvider().standard_client

    s3_client.head_object(Bucket=bucket, Key=key)  # Make sure it exists
    s3_client.delete_object(Bucket=bucket, Key=key)  # Actually delete it


def list_object_versions(bucket, prefix, recursive=True):
    if prefix and not prefix.endswith('/'):
        raise ValueError("Prefix must end with /")

    list_obj_params = dict(
        Bucket=bucket,
        Prefix=prefix
    )
    if not recursive:
        # Treat '/' as a directory separator and only return one level of files instead of everything.
        list_obj_params.update(Delimiter='/')

    # TODO: make this a generator?
    versions = []
    delete_markers = []
    prefixes = []

    s3_client = S3ClientProvider().find_correct_client(S3Api.LIST_OBJECT_VERSIONS, bucket, list_obj_params)
    paginator = s3_client.get_paginator('list_object_versions')

    for response in paginator.paginate(**list_obj_params):
        versions += response.get('Versions', [])
        delete_markers += response.get('DeleteMarkers', [])
        prefixes += response.get('CommonPrefixes', [])

    if recursive:
        return versions, delete_markers
    else:
        return prefixes, versions, delete_markers


def list_objects(bucket, prefix, recursive=True):
    if prefix and not prefix.endswith('/'):
        raise ValueError("Prefix must end with /")

    objects = []
    prefixes = []
    list_obj_params = dict(Bucket=bucket,
                           Prefix=prefix)
    if not recursive:
        # Treat '/' as a directory separator and only return one level of files instead of everything.
        list_obj_params.update(Delimiter='/')

    s3_client = S3ClientProvider().find_correct_client(S3Api.LIST_OBJECTS_V2, bucket, list_obj_params)
    paginator = s3_client.get_paginator('list_objects_v2')

    for response in paginator.paginate(**list_obj_params):
        objects += response.get('Contents', [])
        prefixes += response.get('CommonPrefixes', [])

    if recursive:
        return objects
    else:
        return prefixes, objects


def _looks_like_dir(pk: PhysicalKey):
    return pk.basename() == ''


def list_url(src: PhysicalKey):
    if src.is_local():
        src_file = pathlib.Path(src.path)

        for f in src_file.rglob('*'):
            try:
                if f.is_file():
                    size = f.stat().st_size
                    yield f.relative_to(src_file).as_posix(), size
            except FileNotFoundError:
                # If a file does not exist, is it really a file?
                pass
    else:
        if src.version_id is not None:
            raise ValueError(f"Directories cannot have version IDs: {src}")
        src_path = src.path
        if not _looks_like_dir(src):
            src_path += '/'
        list_obj_params = dict(Bucket=src.bucket, Prefix=src_path)
        s3_client = S3ClientProvider().find_correct_client(S3Api.LIST_OBJECTS_V2, src.bucket, list_obj_params)
        paginator = s3_client.get_paginator('list_objects_v2')
        for response in paginator.paginate(**list_obj_params):
            for obj in response.get('Contents', []):
                key = obj['Key']
                if not key.startswith(src_path):
                    raise ValueError("Unexpected key: %r" % key)
                yield key[len(src_path):], obj['Size']


def delete_url(src: PhysicalKey):
    """Deletes the given URL.
    Follows S3 semantics even for local files:
    - If the URL does not exist, it's a no-op.
    - If it's a non-empty directory, it's also a no-op.
    """
    if src.is_local():
        src_file = pathlib.Path(src.path)

        try:
            if src_file.is_dir():
                try:
                    src_file.rmdir()
                except OSError:
                    # Ignore non-empty directories, for consistency with S3
                    pass
            else:
                src_file.unlink()
        except FileNotFoundError:
            pass
    else:
        s3_client = S3ClientProvider().standard_client
        s3_client.delete_object(Bucket=src.bucket, Key=src.path)


def copy_file_list(file_list, message=None, callback=None):
    """
    Takes a list of tuples (src, dest, size) and copies them in parallel.
    URLs must be regular files, not directories.
    Returns versioned URLs for S3 destinations and regular file URLs for files.
    """
    for src, dest, _ in file_list:
        if _looks_like_dir(src) or _looks_like_dir(dest):
            raise ValueError("Directories are not allowed")

    return _copy_file_list_internal(file_list, [None] * len(file_list), message, callback)


def copy_file(src: PhysicalKey, dest: PhysicalKey, size=None, message=None, callback=None):
    """
    Copies a single file or directory.
    If src is a file, dest can be a file or a directory.
    If src is a directory, dest must be a directory.
    """
    def sanity_check(rel_path):
        for part in rel_path.split('/'):
            if part in ('', '.', '..'):
                raise ValueError("Invalid relative path: %r" % rel_path)

    url_list = []
    if _looks_like_dir(src):
        if not _looks_like_dir(dest):
            raise ValueError("Destination path must end in /")
        if size is not None:
            raise ValueError("`size` does not make sense for directories")

        for rel_path, size in list_url(src):
            sanity_check(rel_path)
            url_list.append((src.join(rel_path), dest.join(rel_path), size))
        if not url_list:
            raise QuiltException("No objects to download.")
    else:
        if _looks_like_dir(dest):
            dest = dest.join(src.basename())
        if size is None:
            size, version_id = get_size_and_version(src)
            if src.version_id is None:
                src = PhysicalKey(src.bucket, src.path, version_id)
        url_list.append((src, dest, size))

    _copy_file_list_internal(url_list, [None] * len(url_list), message, callback)


def put_bytes(data: bytes, dest: PhysicalKey):
    if _looks_like_dir(dest):
        raise ValueError("Invalid path: %r" % dest.path)

    if dest.is_local():
        dest_file = pathlib.Path(dest.path)
        dest_file.parent.mkdir(parents=True, exist_ok=True)
        dest_file.write_bytes(data)
    else:
        if dest.version_id is not None:
            raise ValueError("Cannot set VersionId on destination")
        s3_client = S3ClientProvider().standard_client
        s3_client.put_object(
            Bucket=dest.bucket,
            Key=dest.path,
            Body=data,
        )


def _local_get_bytes(pk: PhysicalKey):
    return pathlib.Path(pk.path).read_bytes()


def _s3_query_object(pk: PhysicalKey, *, head=False):
    params = dict(Bucket=pk.bucket, Key=pk.path)
    if pk.version_id is not None:
        params.update(VersionId=pk.version_id)
    s3_client = S3ClientProvider().find_correct_client(
        S3Api.HEAD_OBJECT if head else S3Api.GET_OBJECT, pk.bucket, params)
    return (s3_client.head_object if head else s3_client.get_object)(**params)


def get_bytes(src: PhysicalKey):
    if src.is_local():
        return _local_get_bytes(src)
    return _s3_query_object(src)['Body'].read()


def get_bytes_and_effective_pk(src: PhysicalKey) -> Tuple[bytes, PhysicalKey]:
    if src.is_local():
        return _local_get_bytes(src), src

    resp = _s3_query_object(src)
    return resp['Body'].read(), PhysicalKey(src.bucket, src.path, resp.get('VersionId'))


def get_size_and_version(src: PhysicalKey):
    """
    Gets size and version for the object at a given URL.

    Returns:
        size, version(str)
    """
    if _looks_like_dir(src):
        raise QuiltException("Invalid path: %r; cannot be a directory" % src.path)

    version = None
    if src.is_local():
        src_file = pathlib.Path(src.path)
        if not src_file.is_file():
            raise QuiltException("Not a file: %r" % str(src_file))
        size = src_file.stat().st_size
    else:
        resp = _s3_query_object(src, head=True)
        size = resp['ContentLength']
        version = resp.get('VersionId')
    return size, version


def calculate_sha256(src_list: List[PhysicalKey], sizes: List[int]):
    assert len(src_list) == len(sizes)

    if not src_list:
        return []
    return _calculate_sha256_internal(src_list, sizes, [None] * len(src_list))


def _calculate_hash_get_s3_chunks(ctx, src, size):
    params = dict(Bucket=src.bucket, Key=src.path)
    if src.version_id is not None:
        params.update(VersionId=src.version_id)
    part_size = s3_transfer_config.multipart_chunksize
    is_multi_part = (
        size >= s3_transfer_config.multipart_threshold
        and size > part_size
    )
    part_numbers = (
        range(math.ceil(size / part_size))
        if is_multi_part else
        (None,)
    )
    s3_client = ctx.find_correct_client(S3Api.GET_OBJECT, src.bucket, params)

    def read_to_queue(part_number, put_to_queue, stopped_event):
        try:
            logger.debug('%r part %s: download enqueued', src, part_number)
            # This semaphore is released in iter_queue() when the part is fully
            # downloaded and all chunks are retrieved from the queue or if download
            # fails.
            ctx.pending_parts_semaphore.acquire()
            logger.debug('%r part %s: download started', src, part_number)
            if part_number is not None:
                start = part_number * part_size
                end = min(start + part_size, size) - 1
                part_params = dict(params, Range=f'bytes={start}-{end}')
            else:
                part_params = params

            body = s3_client.get_object(**part_params)['Body']
            for chunk in read_file_chunks(body):
                put_to_queue(chunk)
                if stopped_event.is_set():
                    logger.debug('%r part %s: stopped', src, part_number)
                    break

            logger.debug('%r part %s: downloaded', src, part_number)
        finally:
            put_to_queue(None)

    def iter_queue(part_number):
        q = queue.Queue()
        stopped_event = threading.Event()
        f = ctx.executor.submit(read_to_queue, part_number, q.put_nowait, stopped_event)
        try:
            yield
            yield from iter(q.get, None)
        except GeneratorExit:
            if f.cancel():
                logger.debug('%r part %s: cancelled', src, part_number)
            else:
                stopped_event.set()
        else:
            f.result()  # Propagate exception from read_to_queue() if any.
            logger.debug('%r part %s: processed', src, part_number)
        finally:
            if not f.cancelled():
                ctx.pending_parts_semaphore.release()
                logger.debug('%r part %s: semaphore released', src, part_number)

    generators = deque()
    for gen in map(iter_queue, part_numbers):
        # Step into generator, so it will receive GeneratorExit when it's closed
        # or garbage collected.
        next(gen)
        generators.append(gen)

    return itertools.chain.from_iterable(
        itertools.starmap(generators.popleft, itertools.repeat((), len(part_numbers))))


def with_lock(f):
    lock = threading.Lock()

    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        with lock:
            return f(*args, **kwargs)
    return wrapper


@retry(stop=stop_after_attempt(MAX_FIX_HASH_RETRIES),
       wait=wait_exponential(multiplier=1, min=1, max=10),
       retry=retry_if_result(lambda results: any(r is None or isinstance(r, Exception) for r in results)),
       retry_error_callback=lambda retry_state: retry_state.outcome.result(),
       )
def _calculate_sha256_internal(src_list, sizes, results):
    total_size = sum(
        size
        for size, result in zip(sizes, results)
        if result is None or isinstance(result, Exception)
    )
    # This controls how many parts can be stored in the memory.
    # This includes the ones that are being downloaded or hashed.
    # The number was chosen empirically.
    s3_max_pending_parts = s3_transfer_config.max_request_concurrency * 4
    stopped = False

    def get_file_chunks(src, size):
        with open(src.path, 'rb') as file:
            yield from read_file_chunks(file)

            current_file_size = file.tell()
            if current_file_size != size:
                warnings.warn(
                    f"Expected the package entry at {src!r} to be {size} B in size, but "
                    f"found an object which is {current_file_size} B instead. This "
                    f"indicates that the content of the file changed in between when you "
                    f"included this  entry in the package (via set or set_dir) and now. "
                    f"This should be avoided if possible."
                )

    def _process_url(src, size):
        hash_obj = hashlib.sha256()

        generator, exceptions_to_retry = (
            (get_file_chunks(src, size), ())
            if src.is_local() else
            (
                _calculate_hash_get_s3_chunks(s3_context, src, size),
                (ConnectionError, HTTPClientError, ReadTimeoutError)
            )
        )
        try:
            for chunk in generator:
                hash_obj.update(chunk)
                progress_update(len(chunk))
                if stopped:
                    return
        except exceptions_to_retry as e:
            return e
        else:
            return hash_obj.hexdigest()
        finally:
            # We want this generator to be finished immediately,
            # so it finishes its own tasks.
            del generator

    with tqdm(desc="Hashing", total=total_size, unit='B', unit_scale=True, disable=DISABLE_TQDM) as progress, \
         ThreadPoolExecutor() as executor, \
         ThreadPoolExecutor(
             s3_transfer_config.max_request_concurrency,
             thread_name_prefix='s3-executor',
         ) as s3_executor:
        s3_context = types.SimpleNamespace(
            find_correct_client=with_lock(S3ClientProvider().find_correct_client),
            pending_parts_semaphore=threading.BoundedSemaphore(s3_max_pending_parts),
            executor=s3_executor,
        )
        progress_update = with_lock(progress.update)
        future_to_idx = {
            executor.submit(_process_url, src, size): i
            for i, (src, size, result) in enumerate(zip(src_list, sizes, results))
            if result is None or isinstance(result, Exception)
        }
        try:
            for future in concurrent.futures.as_completed(future_to_idx):
                results[future_to_idx.pop(future)] = future.result()
        finally:
            stopped = True
            while future_to_idx:
                future, idx = future_to_idx.popitem()
                future.cancel()

    return results


def select(src, query, meta=None, raw=False, **kwargs):
    """Perform an S3 Select SQL query, return results as a Pandas DataFrame

    The data returned by Boto3 for S3 Select is fairly convoluted, to say the
    least.  This function returns the result as a dataframe instead.  It also
    performs the following actions, for convenience:

    * If quilt metadata is given, necessary info to handle the select query is
      pulled from the format metadata.
    * If no metadata is present, but the URL indicates an object with a known
      extension, the file format (and potentially compression) are determeined
      by that extension.
      * Extension may include a compresssion extension in cases where that is
        supported by AWS -- I.e, for queries on JSON or CSV files, .bz2 and
        .gz are supported.
      * Parquet files must not be compressed as a whole, and should not have
        a compression extension.  However, columnar GZIP and Snappy are
        transparently supported.

    Args:
        src(PhysicalKey):  S3 PhysicalKey of the object to query
        query(str): An SQL query using the 'SELECT' directive. See examples at
            https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectSELECTContent.html
        meta: Quilt Object Metadata
        raw(bool):  True to return the raw Boto3 response object
        **kwargs:  s3_client.select() kwargs override.
            All kwargs specified passed to S3 client directly, overriding
            matching default/generated kwargs for `select_object_content()`.
            Note that this will also override the bucket and key specified in
            the URL if `Bucket` and `Key` are passed as kwargs.

    Returns: pandas.DataFrame | dict
        dict is returned if 'raw' is True or if OutputSerialization is set to
            something other than JSON Lines.

    """
    # We don't process any other kind of response at this time.
    output_serialization = {'JSON': {}}
    query_type = "SQL"  # AWS S3 doesn't currently support anything else.
    meta = meta if meta is not None else {}

    # Internal Format Name <--> S3 Format Name
    valid_s3_select_formats = {
        'parquet': 'Parquet',
        'json': 'JSON',
        'jsonl': 'JSON',
        'csv': 'CSV',
        }
    # S3 Format Name <--> S3-Acceptable compression types
    format_compression = {
        'Parquet': ['NONE'],  # even if column-level compression has been used.
        'JSON': ['NONE', 'BZIP2', 'GZIP'],
        'CSV': ['NONE', 'BZIP2', 'GZIP'],
        }
    # File extension <--> S3-Acceptable compression type
    # For compression type, when not specified in metadata.  Guess by extension.
    accepted_compression = {
        '.bz2': 'BZIP2',
        '.gz': 'GZIP'
        }
    # Extension <--> Internal Format Name
    # For file type, when not specified in metadata. Guess by extension.
    ext_formats = {
        '.parquet': 'parquet',
        '.json': 'json',
        '.jsonl': 'jsonl',
        '.csv': 'csv',
        '.tsv': 'csv',
        '.ssv': 'csv',
        }
    delims = {'.tsv': '\t', '.ssv': ';'}

    assert not src.is_local(), "src must be an S3 URL"

    # TODO: what about version_id???

    # TODO: Use formats lib for this stuff
    # use metadata to get format and compression
    compression = None
    format = meta.get('target')
    if format is None:
        format = meta.get('format', {}).get('name')
        if format in ('bzip2', 'gzip'):
            compression = format.upper()
            format = meta.get('format', {}).get('contained_format', {}).get('name')

    # use file extensions to get compression info, if none is present
    exts = pathlib.Path(src.path).suffixes  # last of e.g. ['.periods', '.in', '.name', '.json', '.gz']
    if exts and not compression:
        if exts[-1].lower() in accepted_compression:
            compression = accepted_compression[exts.pop(-1)]   # remove e.g. '.gz'
    compression = compression if compression else 'NONE'

    # use remaining file extensions to get format info, if none is present
    csv_delim = None
    if exts and not format:
        ext = exts[-1].lower()    # last of e.g. ['.periods', '.in', '.name', '.json']
        if ext in ext_formats:
            format = ext_formats[ext]
            csv_delim = delims.get(ext)
            s3_format = valid_s3_select_formats[format]
            ok_compression = format_compression[s3_format]
            if compression not in ok_compression:
                raise QuiltException("Compression {!r} not valid for select on format {!r}: "
                                     "Expected {!r}".format(compression, s3_format, ok_compression))
    if not format:
        raise QuiltException("Unable to discover format for select on {}".format(src))

    # At this point, we have a known format and enough information to use it.
    s3_format = valid_s3_select_formats[format]

    # Create InputSerialization section if not user-specified.
    input_serialization = None
    if 'InputSerialization' not in kwargs:
        input_serialization = {'CompressionType': compression}
        format_spec = input_serialization.setdefault(s3_format, {})

        if s3_format == 'JSON':
            format_spec['Type'] = "LINES" if format == 'jsonl' else "DOCUMENT"
        elif s3_format == 'CSV':
            if csv_delim is not None:
                format_spec['FieldDelimiter'] = csv_delim

    # These are processed and/or default args.
    select_kwargs = dict(
        Bucket=src.bucket,
        Key=src.path,
        Expression=query,
        ExpressionType=query_type,
        InputSerialization=input_serialization,
        OutputSerialization=output_serialization,
    )
    # Include user-specified passthrough options, overriding other options
    select_kwargs.update(kwargs)

    # S3 Select does not support anonymous access (as of Jan 2019)
    # https://docs.aws.amazon.com/AmazonS3/latest/API/API_SelectObjectContent.html
    s3_client = S3ClientProvider().standard_client
    response = s3_client.select_object_content(**select_kwargs)

    # we don't want multiple copies of large chunks of data hanging around.
    # ..iteration ftw.  It's what we get from amazon, anyways..
    def iter_chunks(resp):
        for item in resp['Payload']:
            chunk = item.get('Records', {}).get('Payload')
            if chunk is None:
                continue
            yield chunk

    def iter_lines(resp, delimiter):
        # S3 may break chunks off at any point, so we need to find line endings and handle
        # line breaks manually.
        # Note: this isn't reliable for CSV, because CSV may have a quoted line ending,
        # whereas line endings in JSONLines content will be encoded cleanly.
        lastline = ''
        for chunk in iterdecode(iter_chunks(resp), 'utf-8'):
            lines = chunk.split(delimiter)
            lines[0] = lastline + lines[0]
            lastline = lines.pop(-1)
            for line in lines:
                yield line + delimiter
        yield lastline

    if not raw:
        # JSON used for processed content as it doesn't have the ambiguity of CSV.
        if 'JSON' in select_kwargs["OutputSerialization"]:
            delimiter = select_kwargs['OutputSerialization']['JSON'].get('RecordDelimiter', '\n')
            reader = jsonlines.Reader(line.strip() for line in iter_lines(response, delimiter)
                                      if line.strip())
            # noinspection PyPackageRequirements
            from pandas import DataFrame  # Lazy import for slow module

            # !! if this response type is modified, update related docstrings on Bucket.select().
            return DataFrame.from_records(x for x in reader)
        # If there's some need, we could implement some other OutputSerialization format here.
        # If they've specified an OutputSerialization key we don't handle, just give them the
        # raw response.
    # !! if this response type is modified, update related docstrings on Bucket.select().
    return response
