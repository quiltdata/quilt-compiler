import functools
import gc
import hashlib
import inspect
import io
import json
import os
import pathlib
import shutil
import textwrap
import time
import uuid
import warnings
from collections import deque
from multiprocessing import Pool

import jsonlines
from tqdm import tqdm

from . import workflows
from .backends import get_package_registry
from .data_transfer import (
    calculate_sha256,
    copy_file,
    copy_file_list,
    get_bytes,
    get_size_and_version,
    list_object_versions,
    list_url,
    put_bytes,
)
from .exceptions import PackageException
from .formats import FormatRegistry
from .telemetry import ApiTelemetry
from .util import CACHE_PATH, DISABLE_TQDM, PACKAGE_UPDATE_POLICY
from .util import TEMPFILE_DIR_PATH as APP_DIR_TEMPFILE_DIR
from .util import (
    PhysicalKey,
    QuiltException,
    RemovedInQuilt4Warning,
    catalog_package_url,
    extract_file_extension,
    fix_url,
    get_from_config,
    get_install_location,
    parse_sub_package_name,
    quiltignore_filter,
    user_is_configured_to_custom_stack,
    validate_key,
    validate_package_name,
)


def _fix_docstring(**kwargs):
    def f(wrapped):
        wrapped.__doc__ = textwrap.dedent(wrapped.__doc__) % kwargs
        return wrapped
    return f


_WORKFLOW_PARAM_DOCSTRING = (
    'workflow: workflow ID or `None` to skip workflow validation.\n'
    '        If not specified, the default workflow will be used.\n'
    '        For details see: https://docs.quiltdata.com/advanced-usage/workflows\n'
)


def _delete_local_physical_key(pk):
    assert pk.is_local(), "This function only works on files that live on a local disk"
    pathlib.Path(pk.path).unlink()


def _filesystem_safe_encode(key):
    """Returns the sha256 of the key. This ensures there are no slashes, uppercase/lowercase conflicts,
    avoids `OSError: [Errno 36] File name too long:`, etc."""
    return hashlib.sha256(key.encode()).hexdigest()


class ObjectPathCache:
    @classmethod
    def _cache_path(cls, url):
        url_hash = _filesystem_safe_encode(url)
        return CACHE_PATH / url_hash[0:2] / url_hash[2:]

    @classmethod
    def get(cls, url):
        cache_path = cls._cache_path(url)
        try:
            with open(cache_path) as fd:
                path, dev, ino, mtime = json.load(fd)
        except (FileNotFoundError, ValueError):
            return None

        try:
            stat = pathlib.Path(path).stat()
        except FileNotFoundError:
            return None

        # check if device, file, and timestamp are unchanged => cache hit
        # see also https://docs.python.org/3/library/os.html#os.stat_result
        if stat.st_dev == dev and stat.st_ino == ino and stat.st_mtime_ns == mtime:
            return path
        else:
            return None

    @classmethod
    def set(cls, url, path):
        stat = pathlib.Path(path).stat()
        cache_path = cls._cache_path(url)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(cache_path, 'w') as fd:
            json.dump([path, stat.st_dev, stat.st_ino, stat.st_mtime_ns], fd)

    @classmethod
    def clear(cls):
        shutil.rmtree(CACHE_PATH)


class PackageEntry:
    """
    Represents an entry at a logical key inside a package.
    """
    __slots__ = ['physical_key', 'size', 'hash', '_meta']

    def __init__(self, physical_key, size, hash_obj, meta):
        """
        Creates an entry.

        Args:
            physical_key: a URI (either `s3://` or `file://`)
            size(number): size of object in bytes
            hash({'type': string, 'value': string}): hash object
                for example: {'type': 'SHA256', 'value': 'bb08a...'}
            meta(dict): metadata dictionary

        Returns:
            a PackageEntry
        """
        assert isinstance(physical_key, PhysicalKey)
        self.physical_key = physical_key
        self.size = size
        self.hash = hash_obj
        self._meta = meta or {}

    def __eq__(self, other):
        return (
            # Don't check physical keys.
            self.size == other.size
            and self.hash == other.hash
            and self._meta == other._meta
        )

    def __repr__(self):
        return f"PackageEntry('{self.physical_key}')"

    def as_dict(self):
        """
        Returns dict representation of entry.
        """
        return {
            'physical_keys': [str(self.physical_key)],
            'size': self.size,
            'hash': self.hash,
            'meta': self._meta
        }

    @property
    def meta(self):
        return self._meta.get('user_meta', dict())

    def set_meta(self, meta):
        """
        Sets the user_meta for this PackageEntry.
        """
        self._meta['user_meta'] = meta

    def _verify_hash(self, read_bytes):
        """
        Verifies hash of bytes
        """
        if self.hash is None:
            raise QuiltException("Hash missing - need to build the package")
        if self.hash.get('type') != 'SHA256':
            raise NotImplementedError
        digest = hashlib.sha256(read_bytes).hexdigest()
        if digest != self.hash.get('value'):
            raise QuiltException("Hash validation failed")

    def set(self, path=None, meta=None):
        """
        Returns self with the physical key set to path.

        Args:
            path(string): new path to place at logical_key in the package
                Currently only supports a path on local disk
            meta(dict): metadata dict to attach to entry. If meta is provided, set just
                updates the meta attached to logical_key without changing anything
                else in the entry

        Returns:
            self
        """
        if path is not None:
            self.physical_key = PhysicalKey.from_url(fix_url(path))
            self.size = None
            self.hash = None
        elif meta is not None:
            self.set_meta(meta)
        else:
            raise PackageException('Must specify either path or meta')

    def get(self):
        """
        Returns the physical key of this PackageEntry.
        """
        return str(self.physical_key)

    def get_cached_path(self):
        """
        Returns a locally cached physical key, if available.
        """
        if not self.physical_key.is_local():
            return ObjectPathCache.get(str(self.physical_key))
        return None

    def get_bytes(self, use_cache_if_available=True):
        """
        Returns the bytes of the object this entry corresponds to. If 'use_cache_if_available'=True, will first try to
        retrieve the bytes from cache.
        """
        if use_cache_if_available:
            cached_path = self.get_cached_path()
            if cached_path is not None:
                return get_bytes(PhysicalKey(None, cached_path, None))

        data = get_bytes(self.physical_key)
        return data

    def get_as_json(self, use_cache_if_available=True):
        """
        Returns a JSON file as a `dict`. Assumes that the file is encoded using utf-8.

        If 'use_cache_if_available'=True, will first try to retrieve the object from cache.
        """
        obj_bytes = self.get_bytes(use_cache_if_available=use_cache_if_available)
        return json.loads(obj_bytes.decode("utf-8"))

    def get_as_string(self, use_cache_if_available=True):
        """
        Return the object as a string. Assumes that the file is encoded using utf-8.

        If 'use_cache_if_available'=True, will first try to retrieve the object from cache.
        """
        obj_bytes = self.get_bytes(use_cache_if_available=use_cache_if_available)
        return obj_bytes.decode("utf-8")

    def deserialize(self, func=None, **format_opts):
        """
        Returns the object this entry corresponds to.

        Args:
            func: Skip normal deserialization process, and call func(bytes),
                returning the result directly.
            **format_opts: Some data formats may take options.  Though
                normally handled by metadata, these can be overridden here.

        Returns:
            The deserialized object from the logical_key

        Raises:
            physical key failure
            hash verification fail
            when deserialization metadata is not present
        """
        data = get_bytes(self.physical_key)

        if func is not None:
            return func(data)

        pkey_ext = pathlib.PurePosixPath(self.physical_key.path).suffix

        # Verify format can be handled before checking hash.  Raises if none found.
        formats = FormatRegistry.search(None, self._meta, pkey_ext)

        # Verify hash before deserializing..
        self._verify_hash(data)

        return formats[0].deserialize(data, self._meta, pkey_ext, **format_opts)

    def fetch(self, dest=None):
        """
        Gets objects from entry and saves them to dest.

        Args:
            dest: where to put the files
                Defaults to the entry name

        Returns:
            None
        """
        if dest is None:
            name = self.physical_key.basename()
            dest = PhysicalKey.from_path('.').join(name)
        else:
            dest = PhysicalKey.from_url(fix_url(dest))

        copy_file(self.physical_key, dest)

        # return a package reroot package physical keys after the copy operation succeeds
        # see GH#388 for context
        return self.with_physical_key(dest)

    def __call__(self, func=None, **kwargs):
        """
        Shorthand for self.deserialize()
        """
        return self.deserialize(func=func, **kwargs)

    def with_physical_key(self, key):
        return self.__class__(key, self.size, self.hash, self._meta)

    @property
    def physical_keys(self):
        """
        Deprecated
        """
        warnings.warn(
            "PackageEntry.physical_keys is deprecated, use PackageEntry.physical_key instead.",
            category=RemovedInQuilt4Warning,
            stacklevel=2,
        )
        return [self.physical_key]


class PackageRevInfo:
    __slots__ = ('registry', 'name', 'top_hash')

    def __init__(self, registry, name, top_hash):
        self.registry = registry
        self.name = name
        self.top_hash = top_hash


class ManifestJSONDecoder(json.JSONDecoder):
    """
    Standard json.JSONDecoder reuses same `str` objects for JSON properties, while doing
    a single `decode()` call.
    This class also reuses `str` between many `decode()`s.
    """
    def __init__(self, *args, **kwargs):
        @functools.lru_cache(maxsize=None)
        def memoize_key(s):
            return s

        def object_pairs_hook(items):
            return {
                memoize_key(k): v
                for k, v in items
            }

        super().__init__(*args, object_pairs_hook=object_pairs_hook, **kwargs)


class Package:
    """ In-memory representation of a package """

    _origin = None

    def __init__(self):
        self._children = {}
        self._meta = {'version': 'v0'}

    @ApiTelemetry("package.__repr__")
    def __repr__(self, max_lines=20):
        """
        String representation of the Package.
        """
        def _create_str(results_dict, level=0, parent=True):
            """
            Creates a string from the results dict
            """
            result = ''
            keys = sorted(results_dict.keys())
            if not keys:
                return result

            if parent:
                has_remote_entries = any(
                    self._map(
                        lambda lk, entry: not entry.physical_key.is_local()
                    )
                )
                pkg_type = 'remote' if has_remote_entries else 'local'
                result = f'({pkg_type} Package)\n'

            for key in keys:
                result += ' ' + ('  ' * level) + '└─' + key + '\n'
                result += _create_str(results_dict[key], level + 1, parent=False)

            return result

        if not self.keys():
            return '(empty Package)'

        # traverse the tree of package directories and entries to get the list of
        # display objects. candidates is a deque of shape
        # ((logical_key, Package | PackageEntry), [list of parent key])
        candidates = deque(([x, []] for x in self._children.items()))
        results_dict = {}
        results_total = 0
        more_objects_than_lines = False

        while candidates:
            [[logical_key, entry], parent_keys] = candidates.popleft()
            if isinstance(entry, Package):
                logical_key = logical_key + '/'
                new_parent_keys = parent_keys.copy()
                new_parent_keys.append(logical_key)
                for child_key in sorted(entry.keys()):
                    candidates.append([[child_key, entry[child_key]], new_parent_keys])

            current_result_level = results_dict
            for key in parent_keys:
                current_result_level = current_result_level[key]
            current_result_level[logical_key] = {}
            results_total += 1

            if results_total >= max_lines:
                more_objects_than_lines = True
                break

        repr_str = _create_str(results_dict)

        # append '...' if the package is larger than max_size
        if more_objects_than_lines:
            repr_str += ' ' + '...\n'

        return repr_str

    @property
    def meta(self):
        return self._meta.get('user_meta', dict())

    @classmethod
    @ApiTelemetry("package.install")
    def install(cls, name, registry=None, top_hash=None, dest=None, dest_registry=None, *, path=None):
        """
        Installs a named package to the local registry and downloads its files.

        Args:
            name(str): Name of package to install. It also can be passed as NAME/PATH
                (/PATH is deprecated, use the `path` parameter instead),
                in this case only the sub-package or the entry specified by PATH will
                be downloaded.
            registry(str): Registry where package is located.
                Defaults to the default remote registry.
            top_hash(str): Hash of package to install. Defaults to latest.
            dest(str): Local path to download files to.
            dest_registry(str): Registry to install package to. Defaults to local registry.
            path(str): If specified, downloads only `path` or its children.
        """
        if registry is None:
            registry = get_from_config('default_remote_registry')
            if registry is None:
                raise QuiltException(
                    "No registry specified and no default_remote_registry configured. Please "
                    "specify a registry or configure a default remote registry with quilt3.config"
                )
        else:
            registry = fix_url(registry)
        dest_registry = get_package_registry(dest_registry)
        if not dest_registry.is_local:
            raise QuiltException(
                f"Can only 'install' to a local registry, but 'dest_registry' "
                f"{dest_registry!r} is a remote path. To store a package in a remote "
                f"registry, use 'push' or 'build' instead."
            )

        if dest is None:
            dest_parsed = PhysicalKey.from_url(get_install_location()).join(name)
        else:
            dest_parsed = PhysicalKey.from_url(fix_url(dest))
            if not dest_parsed.is_local():
                raise QuiltException(
                    f"Invalid package destination path {dest!r}. 'dest', if set, must point at "
                    f"the local filesystem. To copy a package to a remote registry use 'push' or "
                    f"'build' instead."
                )

        parts = parse_sub_package_name(name)
        if parts and parts[1]:
            warnings.warn(
                "Passing path via package name is deprecated, use the 'path' parameter instead.",
                category=RemovedInQuilt4Warning,
                stacklevel=3,
            )
            name, subpkg_key = parts
            validate_key(subpkg_key)
            if path:
                raise ValueError("You must not pass path via package name and 'path' parameter.")
        elif path:
            validate_key(path)
            subpkg_key = path
        else:
            subpkg_key = None

        pkg = cls._browse(name=name, registry=registry, top_hash=top_hash)
        message = pkg._meta.get('message', None)  # propagate the package message

        file_list = []

        if subpkg_key is not None:
            if subpkg_key not in pkg:
                raise QuiltException(f"Package {name} doesn't contain {subpkg_key!r}.")
            entry = pkg[subpkg_key]
            entries = entry.walk() if isinstance(entry, Package) else ((subpkg_key.split('/')[-1], entry),)
        else:
            entries = pkg.walk()
        for logical_key, entry in entries:
            # Copy the datafiles in the package.
            physical_key = entry.physical_key

            # Try a local cache.
            cached_file = ObjectPathCache.get(str(physical_key))
            if cached_file is not None:
                physical_key = PhysicalKey.from_path(cached_file)

            new_physical_key = dest_parsed.join(logical_key)
            if physical_key != new_physical_key:
                file_list.append((physical_key, new_physical_key, entry.size))

        def _maybe_add_to_cache(old: PhysicalKey, new: PhysicalKey, _):
            if not old.is_local() and new.is_local():
                ObjectPathCache.set(str(old), new.path)

        copy_file_list(file_list, callback=_maybe_add_to_cache, message="Copying objects")

        pkg._build(name, registry=dest_registry, message=message)
        if top_hash is None:
            top_hash = pkg.top_hash
        short_top_hash = dest_registry.shorten_top_hash(name, top_hash)
        print(f"Successfully installed package '{name}', tophash={short_top_hash} from {registry}")

    @classmethod
    def _parse_resolve_hash_args(cls, name, registry, hash_prefix):
        return name, registry, hash_prefix

    @staticmethod
    def _parse_resolve_hash_args_old(registry, hash_prefix):
        return None, registry, hash_prefix

    @classmethod
    def resolve_hash(cls, *args, **kwargs):
        """
        Find a hash that starts with a given prefix.

        Args:
            name (str): name of package
            registry (str): location of registry
            hash_prefix (str): hash prefix with length between 6 and 64 characters
        """
        try:
            name, registry, hash_prefix = cls._parse_resolve_hash_args_old(*args, **kwargs)
        except TypeError:
            name, registry, hash_prefix = cls._parse_resolve_hash_args(*args, **kwargs)
            validate_package_name(name)
            return get_package_registry(registry).resolve_top_hash(name, hash_prefix)
        else:
            registry = get_package_registry(registry)
            if registry.resolve_top_hash_requires_pkg_name:
                raise TypeError(f'Package name is required for resolving top hash at {registry.root}.')
            warnings.warn(
                "Calling resolve_hash() without the 'name' parameter is deprecated.",
                category=RemovedInQuilt4Warning,
                stacklevel=2,
            )
            return registry.resolve_top_hash(name, hash_prefix)

    # This is needed for nice signature in docs.
    resolve_hash.__func__.__signature__ = inspect.signature(_parse_resolve_hash_args.__func__)

    @classmethod
    @ApiTelemetry("package.browse")
    def browse(cls, name, registry=None, top_hash=None):
        """
        Load a package into memory from a registry without making a local copy of
        the manifest.

        Args:
            name(string): name of package to load
            registry(string): location of registry to load package from
            top_hash(string): top hash of package version to load
        """
        return cls._browse(name=name, registry=registry, top_hash=top_hash)

    @classmethod
    def _browse(cls, name, registry=None, top_hash=None):
        validate_package_name(name)
        registry = get_package_registry(registry)

        top_hash = (
            get_bytes(registry.pointer_latest_pk(name)).decode()
            if top_hash is None else
            registry.resolve_top_hash(name, top_hash)
        )
        pkg_manifest = registry.manifest_pk(name, top_hash)
        if pkg_manifest.is_local():
            local_pkg_manifest = pkg_manifest.path
        else:
            local_pkg_manifest = CACHE_PATH / "manifest" / _filesystem_safe_encode(str(pkg_manifest))
            if not local_pkg_manifest.exists():
                # Copy to a temporary file first, to make sure we don't cache a truncated file
                # if the download gets interrupted.
                tmp_path = local_pkg_manifest.with_suffix('.tmp')
                copy_file(pkg_manifest, PhysicalKey.from_path(tmp_path), message="Downloading manifest")
                tmp_path.rename(local_pkg_manifest)

        return cls._from_path(local_pkg_manifest)

    @classmethod
    def _from_path(cls, path):
        """ Takes a path and returns a package loaded from that path"""
        with open(path, encoding='utf-8') as open_file:
            pkg = cls._load(open_file)
        return pkg

    @classmethod
    def _split_key(cls, logical_key):
        """
        Converts a string logical key like 'a/b/c' into a list of ['a', 'b', 'c'].
        Returns the original key if it's already a list or a tuple.
        """
        if isinstance(logical_key, str):
            path = logical_key.split('/')
        elif isinstance(logical_key, (tuple, list)):
            path = logical_key
        else:
            raise TypeError('Invalid logical_key: %r' % logical_key)
        return path

    def __contains__(self, logical_key):
        """
        Checks whether the package contains a specified logical_key.

        Returns:
            True or False
        """
        try:
            self[logical_key]
            return True
        except KeyError:
            return False

    def __getitem__(self, logical_key):
        """
        Filters the package based on prefix, and returns either a new Package
            or a PackageEntry.

        Args:
            prefix(str): prefix to filter on

        Returns:
            PackageEntry if prefix matches a logical_key exactly
            otherwise Package
        """
        pkg = self
        for key_fragment in self._split_key(logical_key):
            pkg = pkg._children[key_fragment]
        return pkg

    @ApiTelemetry("package.fetch")
    def fetch(self, dest='./'):
        """
        Copy all descendants to `dest`. Descendants are written under their logical
        names _relative_ to self.

        Args:
            dest: where to put the files (locally)

        Returns:
            A new Package object with entries from self, but with physical keys
                pointing to files in `dest`.
        """
        nice_dest = PhysicalKey.from_url(fix_url(dest))
        file_list = []
        pkg = Package()

        for logical_key, entry in self.walk():
            physical_key = entry.physical_key
            new_physical_key = nice_dest.join(logical_key)

            file_list.append((physical_key, new_physical_key, entry.size))

            # return a package reroot package physical keys after the copy operation succeeds
            # see GH#388 for context
            new_entry = entry.with_physical_key(new_physical_key)
            pkg._set(logical_key, new_entry)

        copy_file_list(file_list, message="Copying objects")

        return pkg

    def keys(self):
        """
        Returns logical keys in the package.
        """
        return self._children.keys()

    def __iter__(self):
        return iter(self._children)

    def __len__(self):
        return len(self._children)

    def walk(self):
        """
        Generator that traverses all entries in the package tree and returns tuples of (key, entry),
        with keys in alphabetical order.
        """
        for name, child in sorted(self._children.items()):
            if isinstance(child, PackageEntry):
                yield name, child
            else:
                for key, value in child.walk():
                    yield name + '/' + key, value

    def _walk_dir_meta(self):
        """
        Generator that traverses all entries in the package tree and returns
            tuples of (key, meta) for each directory with metadata.
        Keys will all end in '/' to indicate that they are directories.
        """
        for key, child in sorted(self._children.items()):
            if isinstance(child, PackageEntry):
                continue
            meta = child.meta
            if meta:
                yield key + '/', meta
            for child_key, child_meta in child._walk_dir_meta():
                yield key + '/' + child_key, child_meta

    @classmethod
    @ApiTelemetry("package.load")
    def load(cls, readable_file):
        """
        Loads a package from a readable file-like object.

        Args:
            readable_file: readable file-like object to deserialize package from

        Returns:
            A new Package object

        Raises:
            file not found
            json decode error
            invalid package exception
        """
        return cls._load(readable_file=readable_file)

    @classmethod
    def _load(cls, readable_file):
        gc.disable()  # Experiments with COCO (650MB manifest) show disabling GC gives us ~2x performance improvement

        try:
            line_count = 0
            for _ in readable_file:
                line_count += 1
            readable_file.seek(0)

            reader = jsonlines.Reader(
                tqdm(
                    readable_file,
                    desc="Loading manifest",
                    total=line_count,
                    unit="",
                    unit_scale=True,
                    disable=DISABLE_TQDM,
                    bar_format='{l_bar}{bar}| {n}/{total} [{elapsed}<{remaining}, {rate_fmt}]',
                ),
                loads=ManifestJSONDecoder().decode,
            )
            meta = reader.read()
            meta.pop('top_hash', None)  # Obsolete as of PR #130
            pkg = cls()
            pkg._meta = meta

            for obj in reader:
                path = cls._split_key(obj.pop('logical_key'))
                subpkg = pkg._ensure_subpackage(path[:-1])
                key = path[-1]
                if not obj.get('physical_keys', None):
                    # directory-level metadata
                    subpkg.set_meta(obj['meta'])
                    continue
                if key in subpkg._children:
                    raise PackageException("Duplicate logical key while loading package")
                subpkg._children[key] = PackageEntry(
                    PhysicalKey.from_url(obj['physical_keys'][0]),
                    obj['size'],
                    obj['hash'],
                    obj['meta'],
                )
        finally:
            gc.enable()
        return pkg

    def set_dir(self, lkey, path=None, meta=None, update_policy="incoming"):
        """
        Adds all files from `path` to the package.

        Recursively enumerates every file in `path`, and adds them to
            the package according to their relative location to `path`.

        Args:
            lkey(string): prefix to add to every logical key,
                use '/' for the root of the package.
            path(string): path to scan for files to add to package.
                If None, lkey will be substituted in as the path.
            meta(dict): user level metadata dict to attach to lkey directory entry.
            update_policy(str): can be either 'incoming' (default) or 'existing'.
                If 'incoming', whenever logical keys match, always take the new entry from set_dir.
                If 'existing', whenever logical keys match, retain existing entries
                and ignore new entries from set_dir.

        Returns:
            self

        Raises:
            PackageException: When `path` doesn't exist.
            ValueError: When `update_policy` is invalid.
        """
        if update_policy not in PACKAGE_UPDATE_POLICY:
            raise ValueError(f"Update policy should be one of {PACKAGE_UPDATE_POLICY}, not {update_policy!r}")

        lkey = lkey.strip("/")

        if not lkey or lkey == '.' or lkey == './':
            root = self
        else:
            validate_key(lkey)
            root = self._ensure_subpackage(self._split_key(lkey))

        root.set_meta(meta)

        if path:
            src = PhysicalKey.from_url(fix_url(path))
        else:
            src = PhysicalKey.from_path(lkey)

        # TODO: deserialization metadata
        if src.is_local():
            src_path = pathlib.Path(src.path)
            if not src_path.is_dir():
                raise PackageException("The specified directory doesn't exist")

            files = src_path.rglob('*')
            ignore = src_path / '.quiltignore'
            if ignore.exists():
                files = quiltignore_filter(files, ignore, 'file')

            for f in files:
                if not f.is_file():
                    continue
                logical_key = f.relative_to(src_path).as_posix()
                # check update policy
                if update_policy == 'existing' and logical_key in root:
                    continue
                entry = PackageEntry(PhysicalKey.from_path(f), f.stat().st_size, None, None)
                root._set(logical_key, entry)
        else:
            if src.version_id is not None:
                raise PackageException("Directories cannot have versions")
            src_path = src.path
            if src.basename() != '':
                src_path += '/'
            objects, _ = list_object_versions(src.bucket, src_path)
            for obj in objects:
                if not obj['IsLatest']:
                    continue
                # Skip S3 pseduo directory files and Keys that end in /
                if obj['Key'].endswith('/'):
                    if obj['Size'] != 0:
                        warnings.warn(f'Logical keys cannot end in "/", skipping: {obj["Key"]}')
                    continue
                obj_pk = PhysicalKey(src.bucket, obj['Key'], obj.get('VersionId'))
                logical_key = obj['Key'][len(src_path):]
                # check update policy
                if update_policy == 'existing' and logical_key in root:
                    continue
                entry = PackageEntry(obj_pk, obj['Size'], None, None)
                root._set(logical_key, entry)

        return self

    def get(self, logical_key):
        """
        Gets object from logical_key and returns its physical path.
        Equivalent to self[logical_key].get().

        Args:
            logical_key(string): logical key of the object to get

        Returns:
            Physical path as a string.

        Raises:
            KeyError: when logical_key is not present in the package
            ValueError: if the logical_key points to a Package rather than PackageEntry.
        """
        obj = self[logical_key]
        if not isinstance(obj, PackageEntry):
            raise ValueError("Key does not point to a PackageEntry")
        return obj.get()

    def readme(self):
        """
        Returns the README PackageEntry

        The README is the entry with the logical key 'README.md' (case-sensitive). Will raise a QuiltException if
        no such entry exists.
        """
        if "README.md" not in self:
            ex_msg = "This Package is missing a README file. A Quilt recognized README file is a  file named " \
                     "'README.md' (case-insensitive)"
            raise QuiltException(ex_msg)

        return self["README.md"]

    def set_meta(self, meta):
        """
        Sets user metadata on this Package.
        """
        self._meta['user_meta'] = meta
        return self

    def _fix_sha256(self):
        """
        Calculate and set missing hash values
        """
        self._incomplete_entries = [entry for key, entry in self.walk() if entry.hash is None]

        physical_keys = []
        sizes = []
        for entry in self._incomplete_entries:
            physical_keys.append(entry.physical_key)
            sizes.append(entry.size)

        results = calculate_sha256(physical_keys, sizes)
        exc = None
        for entry, obj_hash in zip(self._incomplete_entries, results):
            if isinstance(obj_hash, Exception):
                exc = obj_hash
            else:
                entry.hash = dict(type='SHA256', value=obj_hash)
        if exc:
            incomplete_manifest_path = self._dump_manifest_to_scratch()
            msg = "Unable to reach S3 for some hash values. Incomplete manifest saved to {path}."
            raise PackageException(msg.format(path=incomplete_manifest_path)) from exc

    def _set_commit_message(self, msg):
        """
        Sets a commit message.

        Args:
            msg: a message string

        Returns:
            None

        Raises:
            a ValueError if msg is not a string
        """
        if msg is not None and not isinstance(msg, str):
            raise ValueError(
                f"The package commit message must be a string, but the message provided is an "
                f"instance of {type(msg)}."
            )

        self._meta.update({'message': msg})

    def _dump_manifest_to_scratch(self):
        registry = get_from_config('default_local_registry')
        registry_parsed = PhysicalKey.from_url(registry)
        pkg_manifest_file = registry_parsed.join("scratch").join(str(int(time.time())))

        manifest = io.BytesIO()
        self._dump(manifest)
        put_bytes(
            manifest.getvalue(),
            pkg_manifest_file
        )
        return pkg_manifest_file.path

    @property
    def _workflow(self):
        return self._meta.get('workflow')

    @_workflow.setter
    def _workflow(self, value):
        if value:
            self._meta['workflow'] = value
        else:
            self._meta.pop('workflow', None)

    def _validate_with_workflow(self, *, registry, workflow, message):
        self._workflow = workflows.validate(registry=registry, workflow=workflow, meta=self.meta, message=message)

    @ApiTelemetry("package.build")
    @_fix_docstring(workflow=_WORKFLOW_PARAM_DOCSTRING)
    def build(self, name, registry=None, message=None, *, workflow=...):
        """
        Serializes this package to a registry.

        Args:
            name: optional name for package
            registry: registry to build to
                defaults to local registry
            message: the commit message of the package
            %(workflow)s

        Returns:
            The top hash as a string.
        """
        registry = get_package_registry(registry)
        self._validate_with_workflow(registry=registry, workflow=workflow, message=message)
        return self._build(name=name, registry=registry, message=message)

    def _build(self, name, registry, message):
        validate_package_name(name)
        registry = get_package_registry(registry)

        self._set_commit_message(message)

        self._fix_sha256()
        manifest = io.BytesIO()
        self._dump(manifest)

        top_hash = self.top_hash
        self._timestamp = registry.push_manifest(name, top_hash, manifest.getvalue())
        self._origin = PackageRevInfo(str(registry.base), name, top_hash)

        return top_hash

    @ApiTelemetry("package.dump")
    def dump(self, writable_file):
        """
        Serializes this package to a writable file-like object.

        Args:
            writable_file: file-like object to write serialized package.

        Returns:
            None

        Raises:
            fail to create file
            fail to finish write
        """
        return self._dump(writable_file)

    def _dump(self, writable_file):
        writer = jsonlines.Writer(writable_file)
        for line in self.manifest:
            writer.write(line)

    @property
    def manifest(self):
        """
        Provides a generator of the dicts that make up the serialized package.
        """
        yield self._meta
        for dir_key, meta in self._walk_dir_meta():
            yield {'logical_key': dir_key, 'meta': meta}
        for logical_key, entry in self.walk():
            yield {'logical_key': logical_key, **entry.as_dict()}

    def set(self, logical_key, entry=None, meta=None, serialization_location=None, serialization_format_opts=None):
        """
        Returns self with the object at logical_key set to entry.

        Args:
            logical_key(string): logical key to update
            entry(PackageEntry OR string OR object): new entry to place at logical_key in the package.
                If entry is a string, it is treated as a URL, and an entry is created based on it.
                If entry is None, the logical key string will be substituted as the entry value.
                If entry is an object and quilt knows how to serialize it, it will immediately be serialized and
                written to disk, either to serialization_location or to a location managed by quilt. List of types that
                Quilt can serialize is available by calling `quilt3.formats.FormatRegistry.all_supported_formats()`
            meta(dict): user level metadata dict to attach to entry
            serialization_format_opts(dict): Optional. If passed in, only used if entry is an object. Options to help
                Quilt understand how the object should be serialized. Useful for underspecified file formats like csv
                when content contains confusing characters. Will be passed as kwargs to the FormatHandler.serialize()
                function. See docstrings for individual FormatHandlers for full list of options -
                https://github.com/quiltdata/quilt/blob/master/api/python/quilt3/formats.py
            serialization_location(string): Optional. If passed in, only used if entry is an object. Where the
                serialized object should be written, e.g. "./mydataframe.parquet"

        Returns:
            self
        """
        return self._set(logical_key=logical_key,
                         entry=entry,
                         meta=meta,
                         serialization_location=serialization_location,
                         serialization_format_opts=serialization_format_opts)

    def _set(self, logical_key, entry=None, meta=None, serialization_location=None, serialization_format_opts=None):
        if not logical_key or logical_key.endswith('/'):
            raise QuiltException(
                f"Invalid logical key {logical_key!r}. "
                f"A package entry logical key cannot be a directory."
            )

        validate_key(logical_key)

        if entry is None:
            entry = pathlib.Path(logical_key).resolve().as_uri()

        if isinstance(entry, (str, os.PathLike)):
            src = PhysicalKey.from_url(fix_url(str(entry)))
            size, version_id = get_size_and_version(src)

            # Determine if a new version needs to be appended.
            if not src.is_local() and src.version_id is None and version_id is not None:
                src.version_id = version_id
            entry = PackageEntry(src, size, None, None)
        elif isinstance(entry, PackageEntry):
            assert meta is None

        elif FormatRegistry.object_is_serializable(entry):
            # Use file extension from serialization_location, fall back to file extension from logical_key
            # If neither has a file extension, Quilt picks the serialization format.
            logical_key_ext = extract_file_extension(logical_key)

            serialize_loc_ext = None
            if serialization_location is not None:
                serialize_loc_ext = extract_file_extension(serialization_location)

            if logical_key_ext is not None and serialize_loc_ext is not None:
                assert logical_key_ext == serialize_loc_ext, f"The logical_key and the serialization_location have " \
                                                             f"different file extensions: {logical_key_ext} vs " \
                                                             f"{serialize_loc_ext}. Quilt doesn't know which to use!"

            if serialize_loc_ext is not None:
                ext = serialize_loc_ext
            elif logical_key_ext is not None:
                ext = logical_key_ext
            else:
                ext = None

            format_handlers = FormatRegistry.search(type(entry))
            if ext:
                format_handlers = [f for f in format_handlers if ext in f.handled_extensions]

            if len(format_handlers) == 0:
                error_message = f'Quilt does not know how to serialize a {type(entry)}'
                if ext is not None:
                    error_message += f' as a {ext} file.'
                error_message += '. If you think this should be supported, please open an issue or PR at ' \
                                 'https://github.com/quiltdata/quilt'
                raise QuiltException(error_message)

            if serialization_format_opts is None:
                serialization_format_opts = {}
            serialized_object_bytes, new_meta = format_handlers[0].serialize(entry, meta=None, ext=ext,
                                                                             **serialization_format_opts)
            if serialization_location is None:
                serialization_path = APP_DIR_TEMPFILE_DIR / str(uuid.uuid4())
                if ext:
                    serialization_path = serialization_path.with_suffix(f'.{ext}')
            else:
                serialization_path = pathlib.Path(serialization_location).expanduser().resolve()

            serialization_path.parent.mkdir(exist_ok=True, parents=True)
            serialization_path.write_bytes(serialized_object_bytes)

            size = serialization_path.stat().st_size
            write_pk = PhysicalKey.from_path(serialization_path)
            entry = PackageEntry(write_pk, size, hash_obj=None, meta=new_meta)

        else:
            raise TypeError(f"Expected a string for entry, but got an instance of {type(entry)}.")

        if meta is not None:
            entry.set_meta(meta)

        path = self._split_key(logical_key)

        pkg = self._ensure_subpackage(path[:-1], ensure_no_entry=True)
        if path[-1] in pkg and isinstance(pkg[path[-1]], Package):
            raise QuiltException("Cannot overwrite directory with PackageEntry")
        pkg._children[path[-1]] = entry

        return self

    def _ensure_subpackage(self, path, ensure_no_entry=False):
        """
        Creates a package and any intermediate packages at the given path.

        Args:
            path(list): logical key as a list or tuple
            ensure_no_entry(boolean): if True, throws if this would overwrite
                a PackageEntry that already exists in the tree.

        Returns:
            newly created or existing package at that path
        """
        pkg = self
        for key_fragment in path:
            if ensure_no_entry and key_fragment in pkg \
                    and isinstance(pkg[key_fragment], PackageEntry):
                raise QuiltException("Already a PackageEntry along the path.")
            pkg = pkg._children.setdefault(key_fragment, Package())
        return pkg

    def delete(self, logical_key):
        """
        Returns the package with logical_key removed.

        Returns:
            self

        Raises:
            KeyError: when logical_key is not present to be deleted
        """
        path = self._split_key(logical_key)
        pkg = self[path[:-1]]
        del pkg._children[path[-1]]
        return self

    @property
    def top_hash(self):
        """
        Returns the top hash of the package.

        Note that physical keys are not hashed because the package has
            the same semantics regardless of where the bytes come from.

        Returns:
            A string that represents the top hash of the package
        """
        top_hash = hashlib.sha256()
        assert 'top_hash' not in self._meta
        top_meta = json.dumps(self._meta, sort_keys=True, separators=(',', ':'))
        top_hash.update(top_meta.encode('utf-8'))
        for logical_key, entry in self.walk():
            if entry.hash is None or entry.size is None:
                raise QuiltException(
                    "PackageEntry missing hash and/or size: %s" % entry.physical_key
                )
            entry_dict = entry.as_dict()
            entry_dict['logical_key'] = logical_key
            entry_dict.pop('physical_keys', None)
            entry_dict_str = json.dumps(entry_dict, sort_keys=True, separators=(',', ':'))
            top_hash.update(entry_dict_str.encode('utf-8'))

        return top_hash.hexdigest()

    @ApiTelemetry("package.push")
    @_fix_docstring(workflow=_WORKFLOW_PARAM_DOCSTRING)
    def push(self, name, registry=None, dest=None, message=None, selector_fn=None, *, workflow=...):
        """
        Copies objects to path, then creates a new package that points to those objects.
        Copies each object in this package to path according to logical key structure,
        then adds to the registry a serialized version of this package with
        physical keys that point to the new copies.

        Note that push is careful to not push data unnecessarily. To illustrate, imagine you have
        a PackageEntry: `pkg["entry_1"].physical_key = "/tmp/package_entry_1.json"`

        If that entry would be pushed to `s3://bucket/prefix/entry_1.json`, but
        `s3://bucket/prefix/entry_1.json` already contains the exact same bytes as
        '/tmp/package_entry_1.json', `quilt3` will not push the bytes to s3, no matter what
        `selector_fn('entry_1', pkg["entry_1"])` returns.

        However, selector_fn will dictate whether the new package points to the local file or to s3:

        If `selector_fn('entry_1', pkg["entry_1"]) == False`,
        `new_pkg["entry_1"] = ["/tmp/package_entry_1.json"]`

        If `selector_fn('entry_1', pkg["entry_1"]) == True`,
        `new_pkg["entry_1"] = ["s3://bucket/prefix/entry_1.json"]`

        Args:
            name: name for package in registry
            dest: where to copy the objects in the package
            registry: registry where to create the new package
            message: the commit message for the new package
            selector_fn: An optional function that determines which package entries should be copied to S3.
                The function takes in two arguments, logical_key and package_entry, and should return False if that
                PackageEntry should be skipped during push. If for example you have a package where the files
                are spread over multiple buckets and you add a single local file, you can use selector_fn to
                only push the local file to s3 (instead of pushing all data to the destination bucket).
            %(workflow)s

        Returns:
            A new package that points to the copied objects.
        """
        return self._push(name, registry, dest, message, selector_fn, workflow=workflow, print_info=True)

    def _push(self, name, registry=None, dest=None, message=None, selector_fn=None, *, workflow, print_info):
        if selector_fn is None:
            def selector_fn(*args):
                return True

        validate_package_name(name)

        if registry is None:
            registry = get_from_config('default_remote_registry')
            if registry is None:
                raise QuiltException(
                    "No registry specified and no default remote registry configured. Please "
                    "specify a registry or configure a default remote registry with quilt3.config"
                )
            registry_parsed = PhysicalKey.from_url(fix_url(registry))
        else:
            registry_parsed = PhysicalKey.from_url(fix_url(registry))
            if not registry_parsed.is_local():
                if registry_parsed.path != '':
                    raise QuiltException(
                        f"The 'registry' argument expects an S3 bucket but the S3 object path "
                        f"{registry!r} was provided instead. You probably wanted to set "
                        f"'registry' to {'s3://' + registry_parsed.bucket!r} instead. To specify that package "
                        f"data land in a specific directory use 'dest'."
                    )
            else:
                raise QuiltException(
                    f"Can only 'push' to remote registries in S3, but {registry!r} "
                    f"is a local file. To store a package in the local registry, use "
                    f"'build' instead."
                )

        if dest is None:
            dest_parsed = registry_parsed.join(name)
        else:
            dest_parsed = PhysicalKey.from_url(fix_url(dest))
            if dest_parsed.bucket != registry_parsed.bucket:
                raise QuiltException(
                    f"Invalid package destination path {dest!r}. 'dest', if set, must be a path "
                    f"in the {registry!r} package registry specified by 'registry'."
                )

        registry = get_package_registry(registry)
        self._validate_with_workflow(registry=registry, workflow=workflow, message=message)

        self._fix_sha256()

        pkg = self.__class__()
        pkg._meta = self._meta
        # Since all that is modified is physical keys, pkg will have the same top hash
        file_list = []
        entries = []

        for logical_key, entry in self.walk():
            if not selector_fn(logical_key, entry):
                pkg._set(logical_key, entry)
                continue

            # Copy the datafiles in the package.
            physical_key = entry.physical_key

            new_physical_key = dest_parsed.join(logical_key)
            if (
                physical_key.bucket == new_physical_key.bucket and
                physical_key.path == new_physical_key.path
            ):
                # No need to copy - re-use the original physical key.
                pkg._set(logical_key, entry)
            else:
                entries.append((logical_key, entry))
                file_list.append((physical_key, new_physical_key, entry.size))

        results = copy_file_list(file_list, message="Copying objects")

        for (logical_key, entry), versioned_key in zip(entries, results):
            # Create a new package entry pointing to the new remote key.
            assert versioned_key is not None
            new_entry = entry.with_physical_key(versioned_key)
            pkg._set(logical_key, new_entry)

        def physical_key_is_temp_file(pk):
            if not pk.is_local():
                return False
            return pathlib.Path(pk.path).parent == APP_DIR_TEMPFILE_DIR

        temp_file_logical_keys = [lk for lk, entry in self.walk() if physical_key_is_temp_file(entry.physical_key)]
        temp_file_physical_keys = [self[lk].physical_key for lk in temp_file_logical_keys]

        # Now that data has been pushed, delete tmp files created by pkg.set('KEY', obj)
        with Pool(10) as p:
            p.map(_delete_local_physical_key, temp_file_physical_keys)

        # Update old package to point to the materialized location of the file since the tempfile no longest exists
        for lk in temp_file_logical_keys:
            self._set(lk, pkg[lk])

        top_hash = pkg._build(name, registry=registry, message=message)

        if print_info:
            shorthash = registry.shorten_top_hash(name, top_hash)
            print(f"Package {name}@{shorthash} pushed to s3://{dest_parsed.bucket}")

            if user_is_configured_to_custom_stack():
                navigator_url = get_from_config("navigator_url")

                print(f"Successfully pushed the new package to "
                      f"{catalog_package_url(navigator_url, dest_parsed.bucket, name, tree=False)}")
            else:
                dest_s3_url = str(dest_parsed)
                if not dest_s3_url.endswith("/"):
                    dest_s3_url += "/"
                print(f"Run `quilt3 catalog {dest_s3_url}` to browse.")
                print("Successfully pushed the new package")

        return pkg

    @classmethod
    def rollback(cls, name, registry, top_hash):
        """
        Set the "latest" version to the given hash.

        Args:
            name(str): Name of package to rollback.
            registry(str): Registry where package is located.
            top_hash(str): Hash to rollback to.
        """
        validate_package_name(name)
        registry = get_package_registry(PhysicalKey.from_url(fix_url(registry)))
        top_hash = registry.resolve_top_hash(name, top_hash)

        # Check that both latest and top_hash actually exist.
        get_size_and_version(registry.manifest_pk(name, top_hash))
        latest_path = registry.pointer_latest_pk(name)
        get_size_and_version(registry.pointer_latest_pk(name))

        put_bytes(top_hash.encode('utf-8'), latest_path)

    @ApiTelemetry("package.diff")
    def diff(self, other_pkg):
        """
        Returns three lists -- added, modified, deleted.

        Added: present in other_pkg but not in self.
        Modified: present in both, but different.
        Deleted: present in self, but not other_pkg.

        Args:
            other_pkg: Package to diff

        Returns:
            added, modified, deleted (all lists of logical keys)
        """
        deleted = []
        modified = []
        other_entries = dict(other_pkg.walk())
        for lk, entry in self.walk():
            other_entry = other_entries.pop(lk, None)
            if other_entry is None:
                deleted.append(lk)
            elif entry != other_entry:
                modified.append(lk)

        added = list(sorted(other_entries))

        return added, modified, deleted

    @ApiTelemetry("package.map")
    def map(self, f, include_directories=False):
        """
        Performs a user-specified operation on each entry in the package.

        Args:
            f(x, y): function
                The function to be applied to each package entry.
                It should take two inputs, a logical key and a PackageEntry.
            include_directories: bool
                Whether or not to include directory entries in the map.

        Returns: list
            The list of results generated by the map.
        """
        return self._map(f, include_directories=include_directories)

    def _map(self, f, include_directories=False):

        if include_directories:
            for lk, _ in self._walk_dir_meta():
                yield f(lk, self[lk.rstrip("/")])

        for lk, entity in self.walk():
            yield f(lk, entity)

    @ApiTelemetry("package.filter")
    def filter(self, f, include_directories=False):
        """
        Applies a user-specified operation to each entry in the package,
        removing results that evaluate to False from the output.

        Args:
            f(x, y): function
                The function to be applied to each package entry.
                It should take two inputs, a logical key and a PackageEntry.
                This function should return a boolean.
            include_directories: bool
                Whether or not to include directory entries in the map.

        Returns:
            A new package with entries that evaluated to False removed
        """
        return self._filter(f=f, include_directories=include_directories)

    def _filter(self, f, include_directories=False):
        p = Package()

        excluded_dirs = set()
        if include_directories:
            for lk, _ in self._walk_dir_meta():
                if not f(lk, self[lk.rstrip("/")]):
                    excluded_dirs.add(lk)

        for lk, entity in self.walk():
            if (not any(p in excluded_dirs
                        for p in pathlib.PurePosixPath(lk).parents)
                    and f(lk, entity)):
                p._set(lk, entity)

        return p

    def verify(self, src, extra_files_ok=False):
        """
        Check if the contents of the given directory matches the package manifest.

        Args:
            src(str): URL of the directory
            extra_files_ok(bool): Whether extra files in the directory should cause a failure.

        Returns:
            True if the package matches the directory; False otherwise.
        """
        src = PhysicalKey.from_url(fix_url(src))
        src_dict = dict(list_url(src))
        url_list = []
        size_list = []
        for logical_key, entry in self.walk():
            src_size = src_dict.pop(logical_key, None)
            if src_size is None:
                return False
            if entry.size != src_size:
                return False
            entry_url = src.join(logical_key)
            url_list.append(entry_url)
            size_list.append(src_size)

        if src_dict and not extra_files_ok:
            return False

        hash_list = calculate_sha256(url_list, size_list)
        for (logical_key, entry), url_hash in zip(self.walk(), hash_list):
            if isinstance(url_hash, Exception):
                raise url_hash
            if entry.hash['value'] != url_hash:
                return False

        return True
