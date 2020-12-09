""" Testing for data_transfer.py """

import hashlib
import io
import os
import pathlib
import time
import unittest
from contextlib import redirect_stderr
from unittest import mock

import boto3
import botocore
import botocore.client
import pandas as pd
import pytest
from botocore.exceptions import ClientError, ReadTimeoutError
from botocore.stub import ANY

from quilt3 import data_transfer
from quilt3.util import PhysicalKey

from .utils import QuiltTestCase

# Code

# parquet test moved to test_formats.py

DATA_DIR = pathlib.Path(__file__).parent / 'data'


class DataTransferTest(QuiltTestCase):
    def test_select(self):
        # Note: The boto3 Stubber doesn't work properly with s3_client.select_object_content().
        #       The return value expects a dict where an iterable is in the actual results.
        chunks = [
            b'{"foo": ',
            b'9, "b',
            b'ar": 3',
            b'}\n{"foo"',
            b': 9, "bar": 1}\n{"foo": 6, "bar": 9}\n{"foo":',
            b' 1, "bar": 7}\n{"foo":',
            b' 6, "bar": 1}\n{"foo": 6, "bar": 6}',
            b'\n{"foo": 9, "bar": 6}',
            b'\n{"foo": 6, "bar": 4}\n',
            b'{"foo": 2, "bar": 0}',
            b'\n{"foo": 2, "bar": 0}\n',
            ]
        records = [{'Records': {'Payload': chunk}} for chunk in chunks]
        # noinspection PyTypeChecker
        records.append({'Stats': {
            'BytesScanned': 100,
            'BytesProcessed': 100,
            'BytesReturned': 210,
            }})
        records.append({'End': {}})

        expected_result = pd.DataFrame.from_records([
            {'foo': 9, 'bar': 3},
            {'foo': 9, 'bar': 1},
            {'foo': 6, 'bar': 9},
            {'foo': 1, 'bar': 7},
            {'foo': 6, 'bar': 1},
            {'foo': 6, 'bar': 6},
            {'foo': 9, 'bar': 6},
            {'foo': 6, 'bar': 4},
            {'foo': 2, 'bar': 0},
            {'foo': 2, 'bar': 0},
            ])

        # test normal use from extension
        expected_args = {
            'Bucket': 'foo',
            'Key': 'bar/baz.json',
            'Expression': 'select * from S3Object',
            'ExpressionType': 'SQL',
            'InputSerialization': {
                'CompressionType': 'NONE',
                'JSON': {'Type': 'DOCUMENT'}
                },
            'OutputSerialization': {'JSON': {}},
            }
        boto_return_val = {'Payload': iter(records)}
        with mock.patch.object(self.s3_client, 'select_object_content', return_value=boto_return_val) as patched:
            result = data_transfer.select(PhysicalKey.from_url('s3://foo/bar/baz.json'), 'select * from S3Object')

            patched.assert_called_once_with(**expected_args)
            assert result.equals(expected_result)

        with mock.patch.object(self.s3_client, 'select_object_content'):
            # No format determined.
            with pytest.raises(data_transfer.QuiltException):
                result = data_transfer.select(PhysicalKey.from_url('s3://foo/bar/baz'), 'select * from S3Object')

        # test format-specified in metadata
        expected_args = {
            'Bucket': 'foo',
            'Key': 'bar/baz',
            'Expression': 'select * from S3Object',
            'ExpressionType': 'SQL',
            'InputSerialization': {
                'CompressionType': 'NONE',
                'JSON': {'Type': 'DOCUMENT'}
            },
            'OutputSerialization': {'JSON': {}},
        }

        boto_return_val = {'Payload': iter(records)}
        with mock.patch.object(self.s3_client, 'select_object_content', return_value=boto_return_val) as patched:
            result = data_transfer.select(PhysicalKey.from_url('s3://foo/bar/baz'), 'select * from S3Object',
                                          meta={'target': 'json'})
            assert result.equals(expected_result)
            patched.assert_called_once_with(**expected_args)

        # test compression is specified
        expected_args = {
            'Bucket': 'foo',
            'Key': 'bar/baz.json.gz',
            'Expression': 'select * from S3Object',
            'ExpressionType': 'SQL',
            'InputSerialization': {
                'CompressionType': 'GZIP',
                'JSON': {'Type': 'DOCUMENT'}
                },
            'OutputSerialization': {'JSON': {}},
            }
        boto_return_val = {'Payload': iter(records)}
        with mock.patch.object(self.s3_client, 'select_object_content', return_value=boto_return_val) as patched:
            # result ignored -- returned data isn't compressed, and this has already been tested.
            data_transfer.select(PhysicalKey.from_url('s3://foo/bar/baz.json.gz'), 'select * from S3Object')
            patched.assert_called_once_with(**expected_args)

    def test_get_size_and_version(self):
        response = {
            'ETag': '12345',
            'VersionId': '1.0',
            'ContentLength': 123,
        }
        expected_params = {
            'Bucket': 'my_bucket',
            'Key': 'my_obj',
        }
        self.s3_stubber.add_response('head_object', response, expected_params)

        # Verify the verion is present
        assert data_transfer.get_size_and_version(PhysicalKey.from_url('s3://my_bucket/my_obj'))[1] == '1.0'

    def test_list_local_url(self):
        dir_path = DATA_DIR / 'dir'
        contents = set(list(data_transfer.list_url(PhysicalKey.from_path(dir_path))))
        assert contents == set([
            ('foo.txt', 4),
            ('x/blah.txt', 6)
        ])

    def test_etag(self):
        assert data_transfer._calculate_etag(DATA_DIR / 'small_file.csv') == '"0bec5bf6f93c547bc9c6774acaf85e1a"'
        assert data_transfer._calculate_etag(
            DATA_DIR / 'buggy_parquet.parquet') == '"dfb5aca048931d396f4534395617363f"'

    def test_simple_upload(self):
        path = DATA_DIR / 'small_file.csv'

        # Unversioned bucket
        self.s3_stubber.add_response(
            method='put_object',
            service_response={
            },
            expected_params={
                'Body': ANY,
                'Bucket': 'example',
                'Key': 'foo.csv',
            }
        )

        data_transfer.copy_file(PhysicalKey.from_path(path), PhysicalKey.from_url('s3://example/foo.csv'))

    def test_multi_upload(self):
        path1 = DATA_DIR / 'small_file.csv'
        path2 = DATA_DIR / 'dir/foo.txt'

        # Unversioned bucket
        self.s3_stubber.add_response(
            method='put_object',
            service_response={
            },
            expected_params={
                'Body': ANY,
                'Bucket': 'example1',
                'Key': 'foo.csv',
            }
        )

        # Versioned bucket
        self.s3_stubber.add_response(
            method='put_object',
            service_response={
                'VersionId': 'v123'
            },
            expected_params={
                'Body': ANY,
                'Bucket': 'example2',
                'Key': 'foo.txt',
            }
        )

        # stubber expects responses in order, so disable multi-threading.
        with mock.patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1):
            urls = data_transfer.copy_file_list([
                (PhysicalKey.from_path(path1), PhysicalKey.from_url('s3://example1/foo.csv'), path1.stat().st_size),
                (PhysicalKey.from_path(path2), PhysicalKey.from_url('s3://example2/foo.txt'), path2.stat().st_size),
            ])

            assert urls[0] == PhysicalKey.from_url('s3://example1/foo.csv')
            assert urls[1] == PhysicalKey.from_url('s3://example2/foo.txt?versionId=v123')

    def test_upload_large_file(self):
        path = DATA_DIR / 'large_file.npy'

        self.s3_stubber.add_client_error(
            method='head_object',
            http_status_code=404,
            expected_params={
                'Bucket': 'example',
                'Key': 'large_file.npy',
            }
        )

        self.s3_stubber.add_response(
            method='put_object',
            service_response={
                'VersionId': 'v1'
            },
            expected_params={
                'Body': ANY,
                'Bucket': 'example',
                'Key': 'large_file.npy',
            }
        )

        urls = data_transfer.copy_file_list([
            (PhysicalKey.from_path(path), PhysicalKey.from_url('s3://example/large_file.npy'), path.stat().st_size),
        ])
        assert urls[0] == PhysicalKey.from_url('s3://example/large_file.npy?versionId=v1')

    def test_upload_large_file_etag_match(self):
        path = DATA_DIR / 'large_file.npy'

        self.s3_stubber.add_response(
            method='head_object',
            service_response={
                'ContentLength': path.stat().st_size,
                'ETag': data_transfer._calculate_etag(path),
                'VersionId': 'v1',
            },
            expected_params={
                'Bucket': 'example',
                'Key': 'large_file.npy',
            }
        )

        urls = data_transfer.copy_file_list([
            (PhysicalKey.from_path(path), PhysicalKey.from_url('s3://example/large_file.npy'), path.stat().st_size),
        ])
        assert urls[0] == PhysicalKey.from_url('s3://example/large_file.npy?versionId=v1')

    def test_upload_large_file_etag_mismatch(self):
        path = DATA_DIR / 'large_file.npy'

        self.s3_stubber.add_response(
            method='head_object',
            service_response={
                'ContentLength': path.stat().st_size,
                'ETag': '"123"',
                'VersionId': 'v1',
            },
            expected_params={
                'Bucket': 'example',
                'Key': 'large_file.npy',
            }
        )

        self.s3_stubber.add_response(
            method='put_object',
            service_response={
                'VersionId': 'v2'
            },
            expected_params={
                'Body': ANY,
                'Bucket': 'example',
                'Key': 'large_file.npy',
            }
        )

        urls = data_transfer.copy_file_list([
            (PhysicalKey.from_path(path), PhysicalKey.from_url('s3://example/large_file.npy'), path.stat().st_size),
        ])
        assert urls[0] == PhysicalKey.from_url('s3://example/large_file.npy?versionId=v2')

    def test_multipart_upload(self):
        name = 'very_large_file.bin'
        path = pathlib.Path(name)

        size = 30 * 1024 * 1024
        chunksize = 8 * 1024 * 1024

        chunks = -(-size // chunksize)

        # Create an empty 30MB file; shouldn't take up any actual space on any reasonable filesystem.
        with open(path, 'wb') as fd:
            fd.seek(size - 1)
            fd.write(b'!')

        self.s3_stubber.add_client_error(
            method='head_object',
            http_status_code=404,
            expected_params={
                'Bucket': 'example',
                'Key': name,
            }
        )

        self.s3_stubber.add_response(
            method='create_multipart_upload',
            service_response={
                'UploadId': '123'
            },
            expected_params={
                'Bucket': 'example',
                'Key': name,
            }
        )

        for part_num in range(1, chunks+1):
            self.s3_stubber.add_response(
                method='upload_part',
                service_response={
                    'ETag': 'etag%d' % part_num
                },
                expected_params={
                    'Bucket': 'example',
                    'Key': name,
                    'UploadId': '123',
                    'Body': ANY,
                    'PartNumber': part_num
                }
            )

        self.s3_stubber.add_response(
            method='complete_multipart_upload',
            service_response={},
            expected_params={
                'Bucket': 'example',
                'Key': name,
                'UploadId': '123',
                'MultipartUpload': {
                    'Parts': [{
                        'ETag': 'etag%d' % i,
                        'PartNumber': i
                    } for i in range(1, chunks+1)]
                }
            }
        )

        with mock.patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1):
            data_transfer.copy_file_list([
                (PhysicalKey.from_path(path), PhysicalKey.from_url(f's3://example/{name}'), path.stat().st_size),
            ])

    def test_multipart_copy(self):
        size = 100 * 1024 * 1024 * 1024

        # size / 8MB would give us 12501 chunks - but the maximum allowed is 10000,
        # so we should end with 16MB chunks instead.
        chunksize = 8 * 1024 * 1024
        assert size / chunksize > 10000
        chunksize *= 2

        chunks = -(-size // chunksize)
        assert chunks <= 10000

        self.s3_stubber.add_response(
            method='create_multipart_upload',
            service_response={
                'UploadId': '123'
            },
            expected_params={
                'Bucket': 'example2',
                'Key': 'large_file2.npy',
            }
        )

        for part_num in range(1, chunks+1):
            self.s3_stubber.add_response(
                method='upload_part_copy',
                service_response={
                    'CopyPartResult': {
                        'ETag': 'etag%d' % part_num
                    }
                },
                expected_params={
                    'Bucket': 'example2',
                    'Key': 'large_file2.npy',
                    'UploadId': '123',
                    'PartNumber': part_num,
                    'CopySource': {
                        'Bucket': 'example1',
                        'Key': 'large_file1.npy'
                    },
                    'CopySourceRange': 'bytes=%d-%d' % (
                        (part_num-1) * chunksize,
                        min(part_num * chunksize, size) - 1
                    )
                }
            )

        self.s3_stubber.add_response(
            method='complete_multipart_upload',
            service_response={},
            expected_params={
                'Bucket': 'example2',
                'Key': 'large_file2.npy',
                'UploadId': '123',
                'MultipartUpload': {
                    'Parts': [{
                        'ETag': 'etag%d' % i,
                        'PartNumber': i
                    } for i in range(1, chunks+1)]
                }
            }
        )

        with mock.patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1):
            stderr = io.StringIO()

            with redirect_stderr(stderr), mock.patch('quilt3.data_transfer.DISABLE_TQDM', False):
                data_transfer.copy_file_list([
                    (
                        PhysicalKey.from_url('s3://example1/large_file1.npy'),
                        PhysicalKey.from_url('s3://example2/large_file2.npy'),
                        size
                    ),
                ])
            assert stderr.getvalue()

    @mock.patch('botocore.client.BaseClient._make_api_call')
    def test_calculate_sha256_read_timeout(self, mocked_api_call):
        bucket = 'test-bucket'
        key = 'dir/a'
        vid = 'a1234'

        a_contents = b'a' * 10

        pk = PhysicalKey(bucket, key, vid)
        exc = ReadTimeoutError('Error Uploading', endpoint_url="s3://foobar")
        mocked_api_call.side_effect = exc
        results = data_transfer.calculate_sha256([pk], [len(a_contents)])
        assert mocked_api_call.call_count == data_transfer.MAX_FIX_HASH_RETRIES
        assert results == [exc]

    def test_copy_file_list_retry(self):
        bucket = 'test-bucket'
        other_bucket = f'{bucket}-other'
        key = 'dir/a'
        vid = None

        src = PhysicalKey(bucket, key, vid)
        dst = PhysicalKey(other_bucket, key, vid)

        with mock.patch('botocore.client.BaseClient._make_api_call',
                        side_effect=ClientError({}, 'CopyObject')) as mocked_api_call:
            with pytest.raises(ClientError):
                data_transfer.copy_file_list([(src, dst, 1)])
            self.assertEqual(mocked_api_call.call_count, data_transfer.MAX_COPY_FILE_LIST_RETRIES)

    def test_copy_file_list_retry_non_client_error(self):
        """
        copy_file_list() is not retrying on random exceptions.
        """
        bucket = 'test-bucket'
        other_bucket = f'{bucket}-other'
        key = 'dir/a'
        vid = None

        src = PhysicalKey(bucket, key, vid)
        dst = PhysicalKey(other_bucket, key, vid)

        with mock.patch('botocore.client.BaseClient._make_api_call',
                        side_effect=Exception('test exception')) as mocked_api_call:
            with pytest.raises(Exception, match='test exception'):
                data_transfer.copy_file_list([(src, dst, 1)])
            assert mocked_api_call.call_count == 1

    def test_copy_file_list_multipart_retry(self):
        bucket = 'test-bucket'
        other_bucket = f'{bucket}-other'
        key = 'dir/a'
        vid = None

        src = PhysicalKey(bucket, key, vid)
        dst = PhysicalKey(other_bucket, key, vid)
        parts = 2 * data_transfer.s3_transfer_config.max_request_concurrency
        size = parts * data_transfer.s3_transfer_config.multipart_threshold

        def side_effect(operation_name, *args, **kwargs):
            if operation_name == 'CreateMultipartUpload':
                return {'UploadId': '123'}
            time.sleep(0.1)
            raise ClientError({}, 'CopyObject')

        with mock.patch('botocore.client.BaseClient._make_api_call', side_effect=side_effect):
            with pytest.raises(ClientError):
                data_transfer.copy_file_list([(src, dst, size)])

    @mock.patch.multiple(
        'quilt3.data_transfer.s3_transfer_config',
        multipart_threshold=1,
        multipart_chunksize=1,
        max_request_concurrency=1,
    )
    def test_download_latest_in_versioned_bucket(self):
        bucket = 'example'
        key = 'foo.csv'
        src = PhysicalKey(bucket, key, None)
        latest_version = '1'
        latest_size = 3

        # Check what is the latest version and size.
        expected_params = {
            'Bucket': bucket,
            'Key': key,
        }
        self.s3_stubber.add_response(
            'head_object',
            service_response={
                'VersionId': latest_version,
                'ContentLength': latest_size,
            },
            expected_params=expected_params,
        )
        for i in range(latest_size):
            self.s3_stubber.add_response(
                'get_object',
                service_response={
                    'Body': io.BytesIO(b'0'),
                },
                expected_params={
                    **expected_params,
                    'Range': f'bytes={i}-{i}',
                    # Version must be specified, otherwise we will end with
                    # a truncated file if the file was modified after getting the latest
                    # version/size.
                    'VersionId': latest_version,
                },
            )

        data_transfer.copy_file(
            src,
            PhysicalKey.from_path('some-file'),
        )


class Success(Exception):
    pass


class S3UploadProgressTest(unittest.TestCase):
    def setUp(self):
        self.s3_client = boto3.client('s3', config=botocore.client.Config(signature_version=botocore.UNSIGNED))
        self.s3_client_patcher = mock.patch.multiple(
            'quilt3.data_transfer.S3ClientProvider',
            _build_client=lambda *args, **kwargs: self.s3_client,
            client_type_known=lambda *args, **kwargs: True,
        )
        self.s3_client_patcher.start()
        self.addCleanup(self.s3_client_patcher.stop)

    def test_body_is_seekable(self):
        """
        No errors if request body.read() or body.seek() are called right before sending request.
        """
        def handler(request, **kwargs):
            request.body.read(2)
            request.body.seek(0)

            raise Success

        path = DATA_DIR / 'small_file.csv'
        self.s3_client.meta.events.register_first('before-send.*', handler)
        with pytest.raises(Success):
            data_transfer.copy_file(PhysicalKey.from_path(path), PhysicalKey.from_url('s3://example/foo.csv'))

    @mock.patch('tqdm.tqdm.update')
    def test_progress_updateds(self, mocked_update):
        """
        Progress callback is called when calling body.read() or body.seek().
        """

        def handler(request, **kwargs):
            request.body.read(2)
            mocked_update.assert_called_once_with(2)

            mocked_update.reset_mock()
            request.body.seek(0)
            mocked_update.assert_called_once_with(-2)

            raise Success

        path = DATA_DIR / 'small_file.csv'
        self.s3_client.meta.events.register_first('before-send.*', handler)
        with pytest.raises(Success):
            data_transfer.copy_file(PhysicalKey.from_path(path), PhysicalKey.from_url('s3://example/foo.csv'))


class S3DownloadTest(QuiltTestCase):
    data = b'0123456789abcdef'
    size = len(data)

    bucket = 'test-bucket'
    key = 'test-key'
    src = PhysicalKey(bucket, key, None)

    filename = 'some-file-name'
    dst = PhysicalKey(None, filename, None)

    def _test_download(self, *, threshold, chunksize, parts=data, devnull=False):
        dst = PhysicalKey(None, os.devnull, None) if devnull else self.dst

        with self.s3_test_multi_thread_download(
            self.bucket, self.key, parts, threshold=threshold, chunksize=chunksize
        ):
            data_transfer.copy_file_list([(self.src, dst, self.size)])

        if not devnull:
            with open(self.filename, 'rb') as f:
                assert f.read() == self.data

    def test_threshold_gt_size(self):
        self._test_download(threshold=self.size + 1, chunksize=5)

    def test_threshold_eq_size(self):
        parts = {
            'bytes=0-4':  self.data[:5],
            'bytes=5-9': self.data[5:10],
            'bytes=10-14': self.data[10:15],
            'bytes=15-15': self.data[15:],
        }
        self._test_download(threshold=self.size, chunksize=5, parts=parts)

    def test_threshold_eq_size_special_file(self):
        if os.name == 'nt':
            with pytest.raises(ValueError, match=f'Cannot download to {os.devnull!r}: reserved file name'):
                self._test_download(threshold=self.size, chunksize=5, devnull=True)
        else:
            self._test_download(threshold=self.size, chunksize=5, devnull=True)

    def test_threshold_eq_chunk_eq_size(self):
        self._test_download(threshold=self.size, chunksize=self.size)

    def test_threshold_eq_chunk_gt_size(self):
        self._test_download(threshold=self.size, chunksize=self.size + 1)


class S3HashingTest(QuiltTestCase):
    data = b'0123456789abcdef'
    size = len(data)
    hasher = hashlib.sha256

    bucket = 'test-bucket'
    key = 'test-key'
    src = PhysicalKey(bucket, key, None)

    def _hashing_subtest(self, *, threshold, chunksize, data=data):
        with self.s3_test_multi_thread_download(
            self.bucket, self.key, data, threshold=threshold, chunksize=chunksize
        ):
            assert data_transfer.calculate_sha256([self.src], [self.size]) == [self.hasher(self.data).hexdigest()]

    def test_single_request(self):
        params = (
            (self.size + 1, 5),
            (self.size, self.size),
            (self.size, self.size + 1),
            (5, self.size),
        )
        for threshold, chunksize in params:
            with self.subTest(threshold=threshold, chunksize=chunksize):
                self._hashing_subtest(threshold=threshold, chunksize=chunksize)

    def test_multi_request(self):
        params = (
            (
                self.size, 5, {
                    'bytes=0-4': self.data[:5],
                    'bytes=5-9': self.data[5:10],
                    'bytes=10-14': self.data[10:15],
                    'bytes=15-15': self.data[15:],
                }
            ),
            (
                5, self.size - 1, {
                    'bytes=0-14': self.data[:15],
                    'bytes=15-15': self.data[15:],
                }
            ),
        )
        for threshold, chunksize, data in params:
            for concurrency in (len(data), 1):
                with mock.patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', concurrency):
                    with self.subTest(threshold=threshold, chunksize=chunksize, data=data, concurrency=concurrency):
                        self._hashing_subtest(threshold=threshold, chunksize=chunksize, data=data)
