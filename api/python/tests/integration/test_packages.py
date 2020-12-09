""" Integration tests for Quilt Packages. """
import io
import locale
import os
import pathlib
import shutil
import tempfile
from collections import Counter
from contextlib import redirect_stderr
from datetime import datetime
from io import BytesIO
from pathlib import Path
from unittest import mock
from unittest.mock import ANY, Mock, call, patch

import jsonlines
import pandas as pd
import pytest

import quilt3
from quilt3 import Package
from quilt3.backends.local import (
    LocalPackageRegistryV1,
    LocalPackageRegistryV2,
)
from quilt3.backends.s3 import S3PackageRegistryV1, S3PackageRegistryV2
from quilt3.util import (
    PhysicalKey,
    QuiltException,
    RemovedInQuilt4Warning,
    validate_package_name,
)

from ..utils import QuiltTestCase

DATA_DIR = Path(__file__).parent / 'data'
LOCAL_MANIFEST = DATA_DIR / 'local_manifest.jsonl'
REMOTE_MANIFEST = DATA_DIR / 'quilt_manifest.jsonl'

SERIALIZATION_DIR = Path('serialization_dir')

LOCAL_REGISTRY = Path('local_registry')  # Set by QuiltTestCase


def _mock_copy_file_list(file_list, callback=None, message=None):
    return [key for _, key, _ in file_list]


class PackageTest(QuiltTestCase):
    default_registry_version = 1
    S3PackageRegistryDefault = S3PackageRegistryV1
    LocalPackageRegistryDefault = LocalPackageRegistryV1

    default_test_top_hash = 'e99b760a05539460ac0a7349abb8f476e8c75282a38845fa828f8a5d28374303'

    def setUp(self):
        super().setUp()

        load_config_wrapped = quilt3.util.load_config

        def load_config_wrapper():
            config = load_config_wrapped()
            config.update(default_registry_version=self.default_registry_version)
            return config

        _config_patcher = patch(
            'quilt3.util.load_config',
            side_effect=load_config_wrapper,
        )
        self.addCleanup(_config_patcher.stop)
        _config_patcher.start()

    def _patch_registry(self, obj, *args, **kwargs):
        patcher = patch.object(obj, *args, **kwargs)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def patch_local_registry(self, *args, **kwargs):
        return self._patch_registry(self.LocalPackageRegistryDefault, *args, **kwargs)

    def patch_s3_registry(self, *args, **kwargs):
        return self._patch_registry(self.S3PackageRegistryDefault, *args, **kwargs)

    def setup_s3_stubber_resolve_pointer(self, pkg_registry, pkg_name, *, pointer, top_hash):
        self.s3_stubber.add_response(
            method='get_object',
            service_response={
                'VersionId': 'v1',
                'Body': BytesIO(top_hash.encode()),
            },
            expected_params={
                'Bucket': pkg_registry.root.bucket,
                'Key': pkg_registry.pointer_pk(pkg_name, pointer).path,
            }
        )

    def setup_s3_stubber_delete_pointer(self, pkg_registry, pkg_name, *, pointer):
        self.s3_stubber.add_response(
            method='delete_object',
            service_response={},
            expected_params={
                'Bucket': pkg_registry.root.bucket,
                'Key': pkg_registry.pointer_pk(pkg_name, pointer).path,
            }
        )

    def setup_s3_stubber_pkg_install(self, pkg_registry, pkg_name, *, top_hash=None, manifest=None, entries=()):
        top_hash = top_hash or self.default_test_top_hash

        self.setup_s3_stubber_resolve_pointer(pkg_registry, pkg_name, pointer='latest', top_hash=top_hash)

        if manifest:
            self.s3_stubber.add_response(
                method='head_object',
                service_response={
                    'VersionId': 'v1',
                    'ContentLength': len(manifest),
                },
                expected_params={
                    'Bucket': pkg_registry.root.bucket,
                    'Key': pkg_registry.manifest_pk(pkg_name, top_hash).path,
                }
            )

            self.s3_stubber.add_response(
                method='get_object',
                service_response={
                    'VersionId': 'v1',
                    'Body': BytesIO(manifest),
                    'ContentLength': len(manifest),
                },
                expected_params={
                    'Bucket': pkg_registry.root.bucket,
                    'VersionId': 'v1',
                    'Key': pkg_registry.manifest_pk(pkg_name, top_hash).path,
                }
            )

        for url, content in entries:
            key = PhysicalKey.from_url(url)
            self.s3_stubber.add_response(
                method='get_object',
                service_response={
                    'VersionId': 'v1',
                    'Body': BytesIO(content),
                },
                expected_params={
                    'Bucket': key.bucket,
                    'Key': key.path,
                }
            )

    def setup_s3_stubber_list_top_hash_candidates(self, pkg_registry, pkg_name, top_hashes):
        self.s3_stubber.add_response(
            method='list_objects_v2',
            service_response={
                'Contents': [
                    {
                        'Key': pkg_registry.manifest_pk(pkg_name, top_hash).path,
                        'Size': 64,
                    }
                    for top_hash in top_hashes
                ]
            },
            expected_params={
                'Bucket': pkg_registry.root.bucket,
                'Prefix': pkg_registry.manifests_package_dir(pkg_name).path,
            }
        )

    def setup_s3_stubber_push_manifest(self, pkg_registry, pkg_name, top_hash, *, pointer_name):
        self.s3_stubber.add_response(
            method='put_object',
            service_response={
                'VersionId': 'v2'
            },
            expected_params={
                'Body': ANY,
                'Bucket': pkg_registry.root.bucket,
                'Key': pkg_registry.manifest_pk(pkg_name, top_hash).path,
            }
        )
        if pkg_registry.revision_pointers:
            self.s3_stubber.add_response(
                method='put_object',
                service_response={
                    'VersionId': 'v3'
                },
                expected_params={
                    'Body': top_hash.encode(),
                    'Bucket': pkg_registry.root.bucket,
                    'Key': pkg_registry.pointer_pk(pkg_name, pointer_name).path,
                }
            )
        self.s3_stubber.add_response(
            method='put_object',
            service_response={
                'VersionId': 'v4'
            },
            expected_params={
                'Body': top_hash.encode(),
                'Bucket': pkg_registry.root.bucket,
                'Key': pkg_registry.pointer_latest_pk(pkg_name).path,
            }
        )

    def setup_s3_stubber_upload_pkg_data(self, pkg_registry, pkg_name, *, lkey, data, version):
        self.s3_stubber.add_response(
            method='put_object',
            service_response={
                'VersionId': version,
            },
            expected_params={
                'Body': ANY,  # TODO: use data here.
                'Bucket': pkg_registry.root.bucket,
                'Key': f'{pkg_name}/{lkey}',
            }
        )

    def setup_s3_stubber_list_pkg_pointers(self, pkg_registry, pkg_name, *, pointers):
        self.s3_stubber.add_response(
            method='list_objects_v2',
            service_response={
                'Contents': [
                    {
                        'Key': pkg_registry.pointer_pk(pkg_name, pointer).path,
                        'Size': 64,
                    }
                    for pointer in pointers
                ]
            },
            expected_params={
                'Bucket': pkg_registry.root.bucket,
                'Prefix': pkg_registry.pointers_dir(pkg_name).path,
            }
        )

    def test_build_default_registry(self):
        """
        build() dumps the manifest to location specified by 'default_local_registry' in config.
        """
        # Create a dummy file to add to the package.
        test_file_name = 'bar'
        test_file = Path(test_file_name).resolve()
        test_file.write_text('test_file_content_string')

        pkg_name = 'Quilt/Test'

        def patch_get_from_config(registry_path):
            return patch(
                'quilt3.backends.get_from_config',
                wraps=quilt3.util.get_from_config,
                side_effect=lambda key: registry_path.as_uri() if key == 'default_local_registry' else mock.DEFAULT,
            )

        for suffix in ('suffix1', 'suffix2'):
            local_registry_path = Path.cwd() / LOCAL_REGISTRY / suffix
            with patch_get_from_config(local_registry_path) as mocked_get_from_config:
                local_registry = self.LocalPackageRegistryDefault(PhysicalKey.from_path(local_registry_path))
                new_pkg = Package()

                # Build a new package into the local registry.
                new_pkg = new_pkg.set('foo', test_file_name)
                top_hash = new_pkg.build(pkg_name)
                mocked_get_from_config.assert_any_call('default_local_registry')

                # Verify manifest is registered by hash.
                with open(local_registry.manifest_pk(pkg_name, top_hash).path) as fd:
                    pkg = Package.load(fd)
                    assert PhysicalKey.from_path(test_file) == pkg['foo'].physical_key

                # Verify latest points to the new location.
                assert Path(local_registry.pointer_latest_pk(pkg_name).path).read_text() == top_hash

    @patch('quilt3.Package._browse', lambda name, registry, top_hash: Package())
    def test_default_install_location(self):
        """Verify that pushes to the default local install location work as expected"""
        self.patch_local_registry('shorten_top_hash', return_value='7a67ff4')
        with patch('quilt3.Package._build') as build_mock:
            pkg_name = 'Quilt/nice-name'
            Package.install(pkg_name, registry='s3://my-test-bucket')

            build_mock.assert_called_once_with(
                pkg_name,
                registry=self.LocalPackageRegistryDefault(
                    PhysicalKey.from_url(quilt3.util.get_install_location())
                ),
                message=None
            )

    def test_read_manifest(self):
        """ Verify reading serialized manifest from disk. """
        with open(LOCAL_MANIFEST) as fd:
            pkg = Package.load(fd)

        out_path = 'new_manifest.jsonl'
        with open(out_path, 'w') as fd:
            pkg.dump(fd)

        # Insepct the jsonl to verify everything is maintained, i.e.
        # that load/dump results in an equivalent set.
        # todo: Use load/dump once __eq__ implemented.
        with open(LOCAL_MANIFEST) as fd:
            original_set = list(jsonlines.Reader(fd))
        with open(out_path) as fd:
            written_set = list(jsonlines.Reader(fd))
        assert len(original_set) == len(written_set)

        if os.name != 'nt':
            # TODO: LOCAL_MANIFEST contains paths like file:///foo -
            # but they're not valid absolute paths on Windows. What do we do?
            assert sorted(original_set, key=lambda k: k.get('logical_key', 'manifest')) \
                == sorted(written_set, key=lambda k: k.get('logical_key', 'manifest'))

    @pytest.mark.usefixtures('isolate_packages_cache')
    def test_remote_browse(self):
        """ Verify loading manifest from s3 """
        registry = 's3://test-bucket'
        pkg_registry = self.S3PackageRegistryDefault(PhysicalKey.from_url(registry))
        pkg_name = 'Quilt/test'

        top_hash = 'abcdefgh' * 8

        # Make the first request.
        self.setup_s3_stubber_pkg_install(
            pkg_registry, pkg_name, top_hash=top_hash, manifest=REMOTE_MANIFEST.read_bytes())

        pkg = Package.browse('Quilt/test', registry=registry)
        assert 'foo' in pkg

        # Make the second request. Gets "latest" - but the rest should be cached.
        self.setup_s3_stubber_pkg_install(pkg_registry, pkg_name, top_hash=top_hash)

        pkg2 = Package.browse(pkg_name, registry=registry)
        assert 'foo' in pkg2

        # Make another request with a top hash. Everything should be cached.

        pkg3 = Package.browse(pkg_name, top_hash=top_hash, registry=registry)
        assert 'foo' in pkg3

        # Make a request with a short hash.
        self.setup_s3_stubber_list_top_hash_candidates(pkg_registry, pkg_name, (top_hash, 'a' * 64))
        pkg3 = Package.browse(pkg_name, top_hash='abcdef', registry=registry)
        assert 'foo' in pkg3

        # Make a request with a bad short hash.

        with pytest.raises(QuiltException, match='Invalid hash'):
            Package.browse(pkg_name, top_hash='abcde', registry=registry)
        with pytest.raises(QuiltException, match='Invalid hash'):
            Package.browse(pkg_name, top_hash='a' * 65, registry=registry)

        # Make a request with a non-existant short hash.
        self.setup_s3_stubber_list_top_hash_candidates(pkg_registry, pkg_name, (top_hash, 'a' * 64))

        with pytest.raises(QuiltException, match='Found zero matches'):
            Package.browse(pkg_name, top_hash='123456', registry=registry)

    def test_install_restrictions(self):
        """Verify that install can only operate remote -> local."""
        # disallow installs which send package data to a remote registry
        with pytest.raises(QuiltException):
            quilt3.Package.install('Quilt/nice-name', dest='s3://test-bucket')

        # disallow installs which send the package manifest to a remote registry
        with pytest.raises(QuiltException):
            quilt3.Package.install('Quilt/nice-name', dest_registry='s3://test-bucket')

    def test_package_fetch(self):
        """ Package.fetch() on nested, relative keys """
        package_ = Package().set_dir('/', DATA_DIR / 'nested')

        out_dir = 'output'
        new_package_ = package_.fetch(out_dir)

        expected = {'one.txt': '1', 'two.txt': '2', 'three.txt': '3'}
        file_count = 0
        for dirpath, _, files in os.walk(out_dir):
            for name in files:
                file_count += 1
                with open(os.path.join(dirpath, name)) as file_:
                    assert name in expected, 'unexpected file: {}'.format(name)
                    contents = file_.read().strip()
                    assert contents == expected[name], \
                        'unexpected contents in {}: {}'.format(name, contents)
        assert file_count == len(expected), \
            'fetch wrote {} files; expected: {}'.format(file_count, expected)

        # test that package re-rooting works as expected
        out_dir_abs_path = pathlib.Path(out_dir).resolve()
        for _, entry in new_package_.walk():
            # relative_to will raise an exception if the first path is not inside the second path.
            pathlib.Path(entry.physical_key.path).relative_to(out_dir_abs_path)

    def test_package_fetch_default_dest(self):
        """Verify fetching a package to the default local destination."""
        Package().set_dir('/', DATA_DIR / 'nested').fetch()
        assert pathlib.Path('one.txt').exists()
        assert pathlib.Path('sub/two.txt').exists()
        assert pathlib.Path('sub/three.txt').exists()

    def test_fetch(self):
        """ Verify fetching a package entry. """
        pkg = (
            Package()
            .set('foo', DATA_DIR / 'foo.txt', {'user_meta': 'blah'})
            .set('bar', DATA_DIR / 'foo.txt', {'user_meta': 'blah'})
        )
        pkg['foo'].meta['target'] = 'unicode'
        pkg['bar'].meta['target'] = 'unicode'

        with open(DATA_DIR / 'foo.txt') as fd:
            assert fd.read().replace('\n', '') == '123'
        # Copy foo.text to bar.txt
        pkg['foo'].fetch('data/bar.txt')
        with open('data/bar.txt') as fd:
            assert fd.read().replace('\n', '') == '123'

        # Raise an error if you copy to yourself.
        with pytest.raises(shutil.SameFileError):
            pkg.set('foo', DATA_DIR / 'foo.txt')['foo'].fetch(DATA_DIR / 'foo.txt')

        # The key gets re-rooted correctly.
        pkg = quilt3.Package().set('foo', DATA_DIR / 'foo.txt')
        new_pkg_entry = pkg['foo'].fetch('bar.txt')
        assert new_pkg_entry.physical_key == PhysicalKey.from_path('bar.txt')

    def test_fetch_default_dest(tmpdir):
        """Verify fetching a package entry to a default destination."""
        with patch('quilt3.packages.copy_file') as copy_mock:
            (Package()
             .set('foo', os.path.join(os.path.dirname(__file__), 'data', 'foo.txt'))['foo']
             .fetch())
            filepath = os.path.join(os.path.dirname(__file__), 'data', 'foo.txt')
            copy_mock.assert_called_once_with(
                PhysicalKey.from_path(filepath),
                PhysicalKey.from_path('foo.txt')
            )

    @patch('quilt3.workflows.validate', mock.MagicMock(return_value=None))
    def test_load_into_quilt(self):
        """ Verify loading local manifest and data into S3. """
        self.patch_s3_registry('shorten_top_hash', return_value='7a67ff4')

        registry = 's3://my_test_bucket/'
        pkg_registry = self.S3PackageRegistryDefault(PhysicalKey.from_url(registry))
        pkg_name = 'Quilt/package'

        def add_pkg_file(pkg, lk, filename, data, *, version):
            path = Path(filename)
            path.write_text(data)
            pkg.set(lk, path)
            self.setup_s3_stubber_upload_pkg_data(pkg_registry, pkg_name, lkey=lk, data=data, version=version)

        new_pkg = Package()
        # Create two dummy files to add to the package.
        add_pkg_file(new_pkg, 'foo1', 'bar1', 'blah', version='v1')
        add_pkg_file(new_pkg, 'foo2', 'bar2', 'omg', version='v1')

        timestamp1 = 1234567890
        self.setup_s3_stubber_push_manifest(
            pkg_registry,
            pkg_name,
            '7fd8e7f49a344aadf4154a2210fe6b08297ecb23218d95027963dc0410548440',
            pointer_name=str(timestamp1),
        )
        with patch('time.time', return_value=timestamp1), \
             patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1):
            remote_pkg = new_pkg.push(pkg_name, registry)

        # Modify one file, and check that only that file gets uploaded.
        add_pkg_file(remote_pkg, 'foo2', 'bar3', '!!!', version='v2')

        timestamp2 = 1234567891
        self.setup_s3_stubber_push_manifest(
            pkg_registry,
            pkg_name,
            'd4efbb1734a53726d97086824d153e6cb5e9d8bc31d15ead0dbc019022cfe539',
            pointer_name=str(timestamp2),
        )
        with patch('time.time', return_value=timestamp2), \
             patch('quilt3.packages.DISABLE_TQDM', True), patch('quilt3.data_transfer.DISABLE_TQDM', True), \
             patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1):
            stderr = io.StringIO()

            with redirect_stderr(stderr), patch('quilt3.packages.DISABLE_TQDM', True):
                remote_pkg.push(pkg_name, registry)
            assert not stderr.getvalue()

    def test_package_deserialize(self):
        """ Verify loading data from a local file. """
        pkg = (
            Package()
            .set('foo', DATA_DIR / 'foo.txt', {'user_meta_foo': 'blah'})
            .set('bar', DATA_DIR / 'foo.unrecognized.ext')
            .set('baz', DATA_DIR / 'foo.txt')
        )
        pkg.build('foo/bar')

        pkg['foo'].meta['target'] = 'unicode'
        assert pkg['foo'].deserialize() == '123\n'
        assert pkg['baz'].deserialize() == '123\n'

        with pytest.raises(QuiltException):
            pkg['bar'].deserialize()

    def test_package_entry_physical_keys(self):
        pkg = Package().set('foo', DATA_DIR / 'foo.txt')
        entry = pkg['foo']
        physical_key = entry.physical_key
        with pytest.warns(RemovedInQuilt4Warning, match='PackageEntry.physical_keys is deprecated'):
            physical_keys = entry.physical_keys
        assert [physical_key] == physical_keys

    def test_local_set_dir(self):
        """ Verify building a package from a local directory. """
        pkg = Package()

        # Create some nested example files that contain their names.
        foodir = pathlib.Path("foo_dir")
        bazdir = pathlib.Path(foodir, "baz_dir")
        bazdir.mkdir(parents=True, exist_ok=True)
        with open('bar', 'w') as fd:
            fd.write(fd.name)
        with open('foo', 'w') as fd:
            fd.write(fd.name)
        with open(bazdir / 'baz', 'w') as fd:
            fd.write(fd.name)
        with open(foodir / 'bar', 'w') as fd:
            fd.write(fd.name)

        pkg = pkg.set_dir("/", ".", meta="test_meta")

        assert PhysicalKey.from_path('foo') == pkg['foo'].physical_key
        assert PhysicalKey.from_path('bar') == pkg['bar'].physical_key
        assert PhysicalKey.from_path(bazdir / 'baz') == pkg['foo_dir/baz_dir/baz'].physical_key
        assert PhysicalKey.from_path(foodir / 'bar') == pkg['foo_dir/bar'].physical_key
        assert pkg.meta == "test_meta"

        pkg = Package()
        pkg = pkg.set_dir('/', 'foo_dir/baz_dir/')
        # todo nested at set_dir site or relative to set_dir path.
        assert PhysicalKey.from_path(bazdir / 'baz') == pkg['baz'].physical_key

        pkg = Package()
        pkg = pkg.set_dir('my_keys', 'foo_dir/baz_dir/')
        # todo nested at set_dir site or relative to set_dir path.
        assert PhysicalKey.from_path(bazdir / 'baz') == pkg['my_keys/baz'].physical_key

        # Verify ignoring files in the presence of a dot-quiltignore
        with open('.quiltignore', 'w') as fd:
            fd.write('foo\n')
            fd.write('bar')

        pkg = Package()
        pkg = pkg.set_dir("/", ".")
        assert 'foo_dir' in pkg.keys()
        assert 'foo' not in pkg.keys() and 'bar' not in pkg.keys()

        with open('.quiltignore', 'w') as fd:
            fd.write('foo_dir')

        pkg = Package()
        pkg = pkg.set_dir("/", ".")
        assert 'foo_dir' not in pkg.keys()

        with open('.quiltignore', 'w') as fd:
            fd.write('foo_dir\n')
            fd.write('foo_dir/baz_dir')

        pkg = Package()
        pkg = pkg.set_dir("/", ".")
        assert 'foo_dir/baz_dir' not in pkg.keys() and 'foo_dir' not in pkg.keys()

        pkg = pkg.set_dir("new_dir", ".", meta="new_test_meta")

        assert PhysicalKey.from_path('foo') == pkg['new_dir/foo'].physical_key
        assert PhysicalKey.from_path('bar') == pkg['new_dir/bar'].physical_key
        assert pkg['new_dir'].meta == "new_test_meta"

        # verify set_dir logical key shortcut
        pkg = Package()
        pkg.set_dir("/")
        assert PhysicalKey.from_path('foo') == pkg['foo'].physical_key
        assert PhysicalKey.from_path('bar') == pkg['bar'].physical_key

    def test_s3_set_dir(self):
        """ Verify building a package from an S3 directory. """
        with patch('quilt3.packages.list_object_versions') as list_object_versions_mock:
            pkg = Package()

            list_object_versions_mock.return_value = ([
                dict(Key='foo/a.txt', VersionId='xyz', IsLatest=True, Size=10),
                dict(Key='foo/x/y.txt', VersionId='null', IsLatest=True, Size=10),
                dict(Key='foo/z.txt', VersionId='123', IsLatest=False, Size=10),
            ], [])

            pkg.set_dir('', 's3://bucket/foo/', meta='test_meta')

            assert pkg['a.txt'].get() == 's3://bucket/foo/a.txt?versionId=xyz'
            assert pkg['x']['y.txt'].get() == 's3://bucket/foo/x/y.txt?versionId=null'
            assert pkg.meta == "test_meta"
            assert pkg['x']['y.txt'].size == 10  # GH368

            list_object_versions_mock.assert_called_with('bucket', 'foo/')

            list_object_versions_mock.reset_mock()

            pkg.set_dir('bar', 's3://bucket/foo')

            assert pkg['bar']['a.txt'].get() == 's3://bucket/foo/a.txt?versionId=xyz'
            assert pkg['bar']['x']['y.txt'].get() == 's3://bucket/foo/x/y.txt?versionId=null'
            assert pkg['bar']['a.txt'].size == 10  # GH368

            list_object_versions_mock.assert_called_with('bucket', 'foo/')

    def test_set_dir_wrong_update_policy(self):
        """Verify non existing update policy raises value error."""
        pkg = Package()
        expected_err = "Update policy should be one of"
        with pytest.raises(ValueError) as e:
            pkg.set_dir("nested", DATA_DIR, update_policy='invalid_policy')
        assert expected_err in str(e.value)

    def test_package_entry_meta(self):
        pkg = (
            Package()
            .set('foo', DATA_DIR / 'foo.txt', {'value': 'blah'})
            .set('bar', DATA_DIR / 'foo.txt', {'value': 'blah2'})
        )
        pkg['foo']._meta['target'] = 'unicode'
        pkg['bar']._meta['target'] = 'unicode'

        assert pkg['foo'].meta == {'value': 'blah'}
        assert pkg['bar'].meta == {'value': 'blah2'}

        assert pkg['foo']._meta == {'target': 'unicode', 'user_meta': {'value': 'blah'}}
        assert pkg['bar']._meta == {'target': 'unicode', 'user_meta': {'value': 'blah2'}}

        pkg['foo'].set_meta({'value': 'other value'})
        assert pkg['foo'].meta == {'value': 'other value'}
        assert pkg['foo']._meta == {'target': 'unicode', 'user_meta': {'value': 'other value'}}

    def local_manifest_timestamp_fixer(self, timestamp):
        return patch('time.time', return_value=timestamp)

    def test_list_local_packages(self):
        """Verify that list returns packages in the appdirs directory."""

        assert not list(quilt3.list_packages())
        assert not list(quilt3.list_package_versions('test/not-exists'))

        pkg_names = ('Quilt/Foo', 'Quilt/Bar', 'Quilt/Test')
        # Build a new package into the local registry.
        timestamp = 1234567890
        with self.local_manifest_timestamp_fixer(timestamp):
            for pkg_name in pkg_names:
                Package().build(pkg_name)

        # Verify packages are returned.
        assert sorted(quilt3.list_packages()) == sorted(pkg_names)

        top_hash = '2a5a67156ca9238c14d12042db51c5b52260fdd5511b61ea89b58929d6e1769b'
        expected_versions = [
            (str(timestamp), top_hash),
        ]
        if self.LocalPackageRegistryDefault.revision_pointers:
            expected_versions.append(('latest', top_hash))

        assert sorted(quilt3.list_package_versions(pkg_names[0])) == sorted(expected_versions)

        # Verify specifying a local path explicitly works as expected.
        assert sorted(quilt3.list_packages()) == sorted(quilt3.list_packages(LOCAL_REGISTRY.as_posix()))

    def test_set_package_entry(self):
        """ Set the physical key for a PackageEntry"""
        pkg = (
            Package()
            .set('foo', DATA_DIR / 'foo.txt', {'user_meta': 'blah'})
            .set('bar', DATA_DIR / 'foo.txt', {'user_meta': 'blah'})
        )
        pkg['foo'].meta['target'] = 'unicode'
        pkg['bar'].meta['target'] = 'unicode'

        # Build a dummy file to add to the map.
        test_file = Path('bar.txt')
        test_file.write_text('test_file_content_string')
        pkg['bar'].set('bar.txt')

        assert PhysicalKey.from_path(test_file) == pkg['bar'].physical_key

        # Test shortcut codepath
        pkg = Package().set('bar.txt')
        assert PhysicalKey.from_path(test_file) == pkg['bar.txt'].physical_key

    @patch('quilt3.workflows.validate', mock.MagicMock(return_value=None))
    def test_set_package_entry_as_object(self):
        self.patch_s3_registry('shorten_top_hash', return_value='7a67ff4')
        pkg = Package()
        nasty_string = 'a,"\tb'
        num_col = [11, 22, 33]
        str_col = ['a', 'b', nasty_string]
        df = pd.DataFrame({'col_num': num_col, 'col_str': str_col})

        # Test with serialization_dir set
        pkg.set("mydataframe1.parquet", df, meta={'user_meta': 'blah'},
                serialization_location=SERIALIZATION_DIR/"df1.parquet")
        pkg.set("mydataframe2.csv", df, meta={'user_meta': 'blah2'},
                serialization_location=SERIALIZATION_DIR/"df2.csv")
        pkg.set("mydataframe3.tsv", df, meta={'user_meta': 'blah3'},
                serialization_location=SERIALIZATION_DIR/"df3.tsv")

        # Test without serialization_dir set
        pkg.set("mydataframe4.parquet", df, meta={'user_meta': 'blah4'})
        pkg.set("mydataframe5.csv", df, meta={'user_meta': 'blah5'})
        pkg.set("mydataframe6.tsv", df, meta={'user_meta': 'blah6'})

        for lk, entry in pkg.walk():
            file_path = entry.physical_key.path
            assert pathlib.Path(file_path).exists(), "The serialization files should exist"

        pkg._fix_sha256()
        for lk, entry in pkg.walk():
            assert df.equals(entry.deserialize()), "The deserialized PackageEntry should be equal to the object " \
                                                   "that was serialized"

        # Test that push cleans up the temporary files, if and only if the serialization_location was not set
        with patch('quilt3.Package._build'), \
             patch('quilt3.packages.copy_file_list', _mock_copy_file_list):
            pkg.push('Quilt/test_pkg_name', 's3://test-bucket')

        for lk in ["mydataframe1.parquet", "mydataframe2.csv", "mydataframe3.tsv"]:
            file_path = pkg[lk].physical_key.path
            assert pathlib.Path(file_path).exists(), "These files should not have been deleted during push()"

        for lk in ["mydataframe4.parquet", "mydataframe5.csv", "mydataframe6.tsv"]:
            file_path = pkg[lk].physical_key.path
            assert not pathlib.Path(file_path).exists(), "These temp files should have been deleted during push()"

    def test_tophash_changes(self):
        test_file = Path('test.txt')
        test_file.write_text('asdf', 'utf-8')

        pkg = Package()
        th1 = pkg.top_hash
        pkg.set('asdf', test_file)
        pkg.build('foo/bar')
        th2 = pkg.top_hash
        assert th1 != th2

        test_file.write_text('jkl', 'utf-8')
        pkg.set('jkl', test_file)
        pkg.build('foo/bar')
        th3 = pkg.top_hash
        assert th1 != th3
        assert th2 != th3

        pkg.delete('jkl')
        th4 = pkg.top_hash
        assert th2 == th4

    def test_top_hash_empty_build(self):
        assert Package().build('pkg/test') == '2a5a67156ca9238c14d12042db51c5b52260fdd5511b61ea89b58929d6e1769b'

    @patch('quilt3.workflows.validate', Mock(return_value='workflow data'))
    def test_top_hash_empty_build_workflow(self):
        assert Package().build('pkg/test') == 'd181e7fd54b64f7f61a3ec33753b93c748748d36fa1e8e6189d598697648a52f'

    def test_keys(self):
        pkg = Package()
        assert not pkg.keys()

        pkg.set('asdf', LOCAL_MANIFEST)
        assert set(pkg.keys()) == {'asdf'}

        pkg.set('jkl;', REMOTE_MANIFEST)
        assert set(pkg.keys()) == {'asdf', 'jkl;'}

        pkg.delete('asdf')
        assert set(pkg.keys()) == {'jkl;'}

    def test_iter(self):
        pkg = Package()
        assert not pkg

        pkg.set('asdf', LOCAL_MANIFEST)
        assert list(pkg) == ['asdf']

        pkg.set('jkl;', REMOTE_MANIFEST)
        assert set(pkg) == {'asdf', 'jkl;'}

    def test_invalid_set_key(self):
        """Verify an exception when setting a key with a path object."""
        pkg = Package()
        with pytest.raises(TypeError):
            pkg.set('asdf/jkl', Package())

    def test_brackets(self):
        pkg = Package()
        pkg.set('asdf/jkl', LOCAL_MANIFEST)
        pkg.set('asdf/qwer', LOCAL_MANIFEST)
        pkg.set('qwer/asdf', LOCAL_MANIFEST)
        assert set(pkg.keys()) == {'asdf', 'qwer'}

        pkg2 = pkg['asdf']
        assert set(pkg2.keys()) == {'jkl', 'qwer'}

        assert pkg['asdf']['qwer'].get() == LOCAL_MANIFEST.as_uri()

        assert pkg['asdf']['qwer'] == pkg['asdf/qwer'] == pkg[('asdf', 'qwer')]
        assert pkg[[]] == pkg

        pkg = (
            Package()
            .set('foo', DATA_DIR / 'foo.txt', {'foo': 'blah'})
        )
        pkg['foo'].meta['target'] = 'unicode'

        pkg.build("Quilt/Test")

        assert pkg['foo'].deserialize() == '123\n'
        assert pkg['foo']() == '123\n'

        with pytest.raises(KeyError):
            pkg['baz']

        with pytest.raises(TypeError):
            pkg[b'asdf']

        with pytest.raises(TypeError):
            pkg[0]

    def _test_list_remote_packages_setup_stubber(self, pkg_registry, *, pkg_names):
        pkg_name1, pkg_name2, pkg_name3 = pkg_names
        pointers = (
            (pkg_name1, '1549931300'),
            (pkg_name1, '1549931634'),
            (pkg_name1, 'latest'),
            (pkg_name2, '1549931301'),
            (pkg_name2, '1549931634'),
            (pkg_name2, 'latest'),
            (pkg_name3, '1549931300'),
            (pkg_name3, '1549931635'),
            (pkg_name3, 'latest'),
        )
        self.s3_stubber.add_response(
            method='list_objects_v2',
            service_response={
                'Contents': [
                    {
                        'Key': pkg_registry.pointer_pk(pkg, pointer).path,
                        'Size': 64,
                    }
                    for pkg, pointer in pointers
                ]
            },
            expected_params={
                'Bucket': pkg_registry.root.bucket,
                'Prefix': pkg_registry.pointers_global_dir.path,
            }
        )

    def test_list_remote_packages(self):
        """Verify that listing remote packages works as expected."""
        registry = 's3://my_test_bucket/'
        pkg_registry = self.S3PackageRegistryDefault(PhysicalKey.from_url(registry))
        pkg_names = ('foo/bar', 'foo/bar1', 'foo1/bar')
        self._test_list_remote_packages_setup_stubber(pkg_registry, pkg_names=pkg_names)
        assert Counter(quilt3.list_packages(registry)) == Counter(pkg_names)

    def test_validate_package_name(self):
        validate_package_name("a/b")
        validate_package_name("21312/bes")
        with pytest.raises(QuiltException):
            validate_package_name("b")
        with pytest.raises(QuiltException):
            validate_package_name("a/b/")
        with pytest.raises(QuiltException):
            validate_package_name("a\\/b")
        with pytest.raises(QuiltException):
            validate_package_name("a/b/c")
        with pytest.raises(QuiltException):
            validate_package_name("a/")
        with pytest.raises(QuiltException):
            validate_package_name("/b")
        with pytest.raises(QuiltException):
            validate_package_name("b")

    def test_diff(self):
        new_pkg = Package()

        # Create a dummy file to add to the package.
        test_file_name = 'bar'
        with open(test_file_name, "w") as fd:
            fd.write('test_file_content_string')
            test_file = Path(fd.name)

        # Build a new package into the local registry.
        new_pkg = new_pkg.set('foo', test_file_name)
        top_hash = new_pkg.build("Quilt/Test")

        p1 = Package.browse('Quilt/Test')
        p2 = Package.browse('Quilt/Test')
        assert p1.diff(p2) == ([], [], [])

    def test_dir_meta(self):
        test_meta = {'test': 'meta'}
        pkg = Package()
        pkg.set('asdf/jkl', LOCAL_MANIFEST)
        pkg.set('asdf/qwer', LOCAL_MANIFEST)
        pkg.set('qwer/asdf', LOCAL_MANIFEST)
        pkg.set('qwer/as/df', LOCAL_MANIFEST)
        pkg.build('Quilt/Test')
        assert pkg['asdf'].meta == {}
        assert pkg.meta == {}
        assert pkg['qwer']['as'].meta == {}
        pkg['asdf'].set_meta(test_meta)
        assert pkg['asdf'].meta == test_meta
        pkg['qwer']['as'].set_meta(test_meta)
        assert pkg['qwer']['as'].meta == test_meta
        pkg.set_meta(test_meta)
        assert pkg.meta == test_meta
        dump_path = 'test_meta'
        with open(dump_path, 'w') as f:
            pkg.dump(f)
        with open(dump_path) as f:
            pkg2 = Package.load(f)
        assert pkg2['asdf'].meta == test_meta
        assert pkg2['qwer']['as'].meta == test_meta
        assert pkg2.meta == test_meta

    def test_top_hash_stable(self):
        """Ensure that top_hash() never changes for a given manifest"""

        top_hash = '20de5433549a4db332a11d8d64b934a82bdea8f144b4aecd901e7d4134f8e733'
        manifest_path = DATA_DIR / 'top_hash_test_manifest.jsonl'
        pkg = Package._from_path(manifest_path)

        assert pkg.top_hash == top_hash, f'Unexpected top_hash for {manifest_path}'

    def test_local_package_delete(self):
        """Verify local package delete works."""
        top_hash = Package().build("Quilt/Test")
        assert 'Quilt/Test' in quilt3.list_packages()

        quilt3.delete_package('Quilt/Test')
        assert 'Quilt/Test' not in quilt3.list_packages()

    def test_local_delete_package_revision(self):
        pkg_name = 'Quilt/Test'
        top_hash1 = 'top_hash1'
        top_hash2 = 'top_hash2'
        top_hash3 = 'top_hash3'
        top_hashes = (top_hash1, top_hash2, top_hash3)

        for i, top_hash in enumerate(top_hashes):
            with patch('quilt3.Package.top_hash', top_hash), \
                 patch('time.time', return_value=i):
                Path(top_hash).write_text(top_hash)
                Package().set(top_hash, top_hash).build(pkg_name)

        # All is set up correctly.
        assert pkg_name in quilt3.list_packages()
        assert {top_hash for _, top_hash in quilt3.list_package_versions(pkg_name)} == set(top_hashes)
        assert Package.browse(pkg_name)[top_hash3].get_as_string() == top_hash3

        # Remove latest revision, latest now points to the previous one.
        quilt3.delete_package(pkg_name, top_hash=top_hash3)
        assert pkg_name in quilt3.list_packages()
        assert {top_hash for _, top_hash in quilt3.list_package_versions(pkg_name)} == {top_hash1, top_hash2}
        assert Package.browse(pkg_name)[top_hash2].get_as_string() == top_hash2

        # Remove non-latest revision, latest stays the same.
        quilt3.delete_package(pkg_name, top_hash=top_hash1)
        assert pkg_name in quilt3.list_packages()
        assert {top_hash for _, top_hash in quilt3.list_package_versions(pkg_name)} == {top_hash2}
        assert Package.browse(pkg_name)[top_hash2].get_as_string() == top_hash2

        # Remove the last revision, package is not listed anymore.
        quilt3.delete_package(pkg_name, top_hash=top_hash2)
        assert pkg_name not in quilt3.list_packages()
        assert not list(quilt3.list_package_versions(pkg_name))

    def _test_remote_package_delete_setup_stubber(self, pkg_registry, pkg_name, *, pointers):
        self.setup_s3_stubber_list_pkg_pointers(pkg_registry, pkg_name, pointers=pointers)
        for pointer in pointers:
            self.setup_s3_stubber_delete_pointer(pkg_registry, pkg_name, pointer=pointer)

    def test_remote_package_delete(self):
        """Verify remote package delete works."""
        registry = 's3://test-bucket'
        pkg_registry = self.S3PackageRegistryDefault(PhysicalKey.from_url(registry))
        pkg_name = 'Quilt/Test'

        self._test_remote_package_delete_setup_stubber(pkg_registry, pkg_name, pointers=('0', 'latest'))

        quilt3.delete_package(pkg_name, registry=registry)

    def _test_remote_revision_delete_setup_stubber(self, pkg_registry, pkg_name, *, top_hashes, latest, remove,
                                                   new_latest):
        pointers = {str(i): top_hash for top_hash, i in top_hashes.items()}
        pointers['latest'] = latest

        self.setup_s3_stubber_list_pkg_pointers(pkg_registry, pkg_name, pointers=pointers)
        for pointer, top_hash in pointers.items():
            self.setup_s3_stubber_resolve_pointer(pkg_registry, pkg_name, pointer=pointer, top_hash=top_hash)
        self.setup_s3_stubber_delete_pointer(pkg_registry, pkg_name, pointer=str(top_hashes[remove]))
        if latest == remove:
            self.setup_s3_stubber_delete_pointer(pkg_registry, pkg_name, pointer='latest')
        if new_latest:
            self.s3_stubber.add_response(
                method='head_object',
                service_response={
                    'ContentLength': len(new_latest),
                },
                expected_params={
                    'Bucket': pkg_registry.root.bucket,
                    'Key': pkg_registry.pointer_pk(pkg_name, str(top_hashes[new_latest])).path,
                }
            )
            self.s3_stubber.add_response(
                method='copy_object',
                service_response={},
                expected_params={
                    'CopySource': {
                        'Bucket': pkg_registry.root.bucket,
                        'Key': pkg_registry.pointer_pk(pkg_name, str(top_hashes[new_latest])).path,
                    },
                    'Bucket': pkg_registry.root.bucket,
                    'Key': pkg_registry.pointer_latest_pk(pkg_name).path,
                }
            )

    def test_remote_delete_package_revision(self):
        self.patch_s3_registry('resolve_top_hash', lambda self, pkg_name, top_hash: top_hash)
        registry = 's3://test-bucket'
        pkg_registry = self.S3PackageRegistryDefault(PhysicalKey.from_url(registry))
        pkg_name = 'Quilt/Test'
        top_hash1 = 'top_hash1'
        top_hash2 = 'top_hash2'
        top_hash3 = 'top_hash3'
        top_hashes = {
            top_hash1: 1,
            top_hash2: 2,
            top_hash3: 3,
        }

        self._test_remote_revision_delete_setup_stubber(
            pkg_registry, pkg_name, top_hashes=top_hashes, latest=top_hash3, new_latest=top_hash2, remove=top_hash3)
        quilt3.delete_package(pkg_name, top_hash=top_hash3, registry=registry)
        top_hashes.pop(top_hash3)

        self._test_remote_revision_delete_setup_stubber(
            pkg_registry, pkg_name, top_hashes=top_hashes, latest=top_hash2, new_latest=None, remove=top_hash1)
        quilt3.delete_package(pkg_name, top_hash=top_hash1, registry=registry)
        top_hashes.pop(top_hash1)

        self._test_remote_revision_delete_setup_stubber(
            pkg_registry, pkg_name, top_hashes=top_hashes, latest=top_hash2, new_latest=None, remove=top_hash2)
        quilt3.delete_package(pkg_name, top_hash=top_hash2, registry=registry)

    def test_push_restrictions(self):
        p = Package()

        # disallow pushing not to the top level of a remote S3 registry
        with pytest.raises(QuiltException):
            p.push('Quilt/Test', 's3://test-bucket/foo/bar')

        # disallow pushing to the local filesystem (use install instead)
        with pytest.raises(QuiltException):
            p.push('Quilt/Test', './')

        # disallow pushing the package manifest to remote but package data to local
        with pytest.raises(QuiltException):
            p.push('Quilt/Test', 's3://test-bucket', dest='./')

        # disallow pushing the pacakge manifest to remote but package data to a different remote
        with pytest.raises(QuiltException):
            p.push('Quilt/Test', 's3://test-bucket', dest='s3://other-test-bucket')

    @patch('quilt3.workflows.validate', return_value=None)
    def test_commit_message_on_push(self, mocked_workflow_validate):
        """ Verify commit messages populate correctly on push."""
        self.patch_s3_registry('shorten_top_hash', return_value='7a67ff4')
        with patch('quilt3.packages.copy_file_list', _mock_copy_file_list), \
             patch('quilt3.Package._build') as build_mock:
            with open(REMOTE_MANIFEST) as fd:
                pkg = Package.load(fd)

            pkg.push('Quilt/test_pkg_name', 's3://test-bucket', message='test_message')
            registry = self.S3PackageRegistryDefault(PhysicalKey.from_url('s3://test-bucket'))
            message = 'test_message'
            build_mock.assert_called_once_with(
                'Quilt/test_pkg_name',
                registry=registry,
                message=message,
            )
            mocked_workflow_validate.assert_called_once_with(
                registry=registry,
                workflow=...,
                meta={},
                message=message,
            )

    def test_overwrite_dir_fails(self):
        with pytest.raises(QuiltException):
            pkg = Package()
            pkg.set('asdf/jkl', LOCAL_MANIFEST)
            pkg.set('asdf', LOCAL_MANIFEST)

    def test_overwrite_entry_fails(self):
        with pytest.raises(QuiltException):
            pkg = Package()
            pkg.set('asdf', LOCAL_MANIFEST)
            pkg.set('asdf/jkl', LOCAL_MANIFEST)

    def test_siblings_succeed(self):
        pkg = Package()
        pkg.set('as/df', LOCAL_MANIFEST)
        pkg.set('as/qw', LOCAL_MANIFEST)

    def test_local_repr(self):
        TEST_REPR = (
            "(local Package)\n"
            " └─asdf\n"
            " └─path1/\n"
            "   └─asdf\n"
            "   └─qwer\n"
            " └─path2/\n"
            "   └─first/\n"
            "     └─asdf\n"
            "   └─second/\n"
            "     └─asdf\n"
            " └─qwer\n"
        )
        pkg = Package()
        pkg.set('asdf', LOCAL_MANIFEST)
        pkg.set('qwer', LOCAL_MANIFEST)
        pkg.set('path1/asdf', LOCAL_MANIFEST)
        pkg.set('path1/qwer', LOCAL_MANIFEST)
        pkg.set('path2/first/asdf', LOCAL_MANIFEST)
        pkg.set('path2/second/asdf', LOCAL_MANIFEST)
        assert repr(pkg) == TEST_REPR

    def test_remote_repr(self):
        with patch('quilt3.packages.get_size_and_version', return_value=(0, '0')):
            TEST_REPR = (
                "(remote Package)\n"
                " └─asdf\n"
            )
            pkg = Package()
            pkg.set('asdf', 's3://my-bucket/asdf')
            assert repr(pkg) == TEST_REPR

            TEST_REPR = (
                "(remote Package)\n"
                " └─asdf\n"
                " └─qwer\n"
            )
            pkg = Package()
            pkg.set('asdf', 's3://my-bucket/asdf')
            pkg.set('qwer', LOCAL_MANIFEST)
            assert repr(pkg) == TEST_REPR

    def test_repr_empty_package(self):
        pkg = Package()
        r = repr(pkg)
        assert r == "(empty Package)"

    def test_manifest(self):
        pkg = Package().set_meta({'metadata': '💩'})
        pkg.set('as/df', LOCAL_MANIFEST)
        pkg.set('as/qw', LOCAL_MANIFEST)
        top_hash = pkg.build('foo/bar')
        manifest = list(pkg.manifest)

        current_locale = locale.setlocale(locale.LC_ALL)
        try:
            for locale_name in ('C', ''):
                with self.subTest(locale_name=locale_name):
                    locale.setlocale(locale.LC_ALL, locale_name)
                    pkg2 = Package.browse('foo/bar', top_hash=top_hash)
                    assert list(pkg2.manifest) == manifest
        finally:
            locale.setlocale(locale.LC_ALL, current_locale)

    @patch('quilt3.Package._build', mock.MagicMock())
    @patch('quilt3.packages.copy_file_list', mock.MagicMock())
    @patch('quilt3.workflows.validate', mock.MagicMock(return_value='workflow data'))
    def test_manifest_workflow(self):
        self.patch_s3_registry('shorten_top_hash', return_value='7a67ff4')
        for method in (Package.build, Package.push):
            with self.subTest(method=method):
                pkg = Package()
                method(pkg, 'foo/bar', registry='s3://test-bucket')
                data, = pkg.manifest
                assert 'workflow' in data
                assert data['workflow'] == "workflow data"

    def test_map(self):
        pkg = Package()
        pkg.set('as/df', LOCAL_MANIFEST)
        pkg.set('as/qw', LOCAL_MANIFEST)
        assert set(pkg.map(lambda lk, entry: lk)) == {'as/df', 'as/qw'}

        pkg['as'].set_meta({'foo': 'bar'})
        assert set(pkg.map(lambda lk, entry: lk, include_directories=True)) ==\
            {'as/df', 'as/qw', 'as/'}

    def test_filter(self):
        pkg = Package()
        pkg.set('a/df', LOCAL_MANIFEST)
        pkg.set('a/qw', LOCAL_MANIFEST)

        p_copy = pkg.filter(lambda lk, entry: lk == 'a/df')
        assert list(p_copy) == ['a'] and list(p_copy['a']) == ['df']

        pkg = Package()
        pkg.set('a/df', LOCAL_MANIFEST)
        pkg.set('a/qw', LOCAL_MANIFEST)
        pkg.set('b/df', LOCAL_MANIFEST)
        pkg['a'].set_meta({'foo': 'bar'})
        pkg['b'].set_meta({'foo': 'bar'})

        p_copy = pkg.filter(lambda lk, entry: lk == 'a/', include_directories=True)
        assert list(p_copy) == []

        p_copy = pkg.filter(lambda lk, entry: lk == 'a/' or lk == 'a/df',
                            include_directories=True)
        assert list(p_copy) == ['a'] and list(p_copy['a']) == ['df']

    @pytest.mark.usefixtures('clear_data_modules_cache')
    def test_import(self):
        with patch('quilt3.Package._browse') as browse_mock, \
             patch.object(self.LocalPackageRegistryDefault, 'list_packages') as list_packages_mock:
            browse_mock.return_value = quilt3.Package()
            list_packages_mock.return_value = ['foo/bar', 'foo/baz']

            from quilt3.data.foo import bar
            assert isinstance(bar, Package)
            browse_mock.assert_has_calls(
                [call('foo/baz', registry=ANY), call('foo/bar', registry=ANY)], any_order=True
            )

            from quilt3.data import foo
            assert hasattr(foo, 'bar') and hasattr(foo, 'baz')

    def test_invalid_key(self):
        pkg = Package()
        with pytest.raises(QuiltException):
            pkg.set('', LOCAL_MANIFEST)
        with pytest.raises(QuiltException):
            pkg.set('foo/', LOCAL_MANIFEST)
        with pytest.raises(QuiltException):
            pkg.set('foo', './')
        with pytest.raises(QuiltException):
            pkg.set('foo', os.path.dirname(__file__))

        # we do not allow '.' or '..' files or filename separators
        with pytest.raises(QuiltException):
            pkg.set('.', LOCAL_MANIFEST)
        with pytest.raises(QuiltException):
            pkg.set('..', LOCAL_MANIFEST)
        with pytest.raises(QuiltException):
            pkg.set('./foo', LOCAL_MANIFEST)
        with pytest.raises(QuiltException):
            pkg.set('../foo', LOCAL_MANIFEST)
        with pytest.raises(QuiltException):
            pkg.set('foo/.', LOCAL_MANIFEST)
        with pytest.raises(QuiltException):
            pkg.set('foo/..', LOCAL_MANIFEST)
        with pytest.raises(QuiltException):
            pkg.set('foo/./bar', LOCAL_MANIFEST)
        with pytest.raises(QuiltException):
            pkg.set('foo/../bar', LOCAL_MANIFEST)

        with pytest.raises(QuiltException):
            pkg.set('s3://foo/.', LOCAL_MANIFEST)
        with pytest.raises(QuiltException):
            pkg.set('s3://foo/..', LOCAL_MANIFEST)

    @pytest.mark.usefixtures('clear_data_modules_cache')
    @pytest.mark.usefixtures('isolate_packages_cache')
    def test_install(self):
        self.patch_local_registry('shorten_top_hash', return_value='7a67ff4')
        registry = 's3://my-test-bucket'
        pkg_registry = self.S3PackageRegistryDefault(PhysicalKey.from_url(registry))
        pkg_name = 'Quilt/Foo'

        self.setup_s3_stubber_pkg_install(
            pkg_registry, pkg_name, manifest=REMOTE_MANIFEST.read_bytes(),
            entries=(
                ('s3://my_bucket/my_data_pkg/bar.csv', b'a,b,c'),
                ('s3://my_bucket/my_data_pkg/baz/bat', b'Hello World!'),
                ('s3://my_bucket/my_data_pkg/foo', '💩'.encode()),
            ),
        )

        with patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1):
            Package.install(pkg_name, registry=registry, dest='package')

        p = Package.browse(pkg_name)

        assert p['foo'].get() == 's3://my_bucket/my_data_pkg/foo'

        # Check that the cache works.
        local_path = pathlib.Path(p['foo'].get_cached_path())
        assert local_path == pathlib.Path.cwd() / 'package/foo'
        assert local_path.read_text('utf8') == '💩'

        # Test that get_bytes and get_as_text works
        assert p['foo'].get_bytes().decode("utf-8") == '💩'
        assert p['foo'].get_as_string() == '💩'

        # Check that moving the file invalidates the cache...
        local_path.rename('foo2')
        assert p['foo'].get_cached_path() is None

        # ...but moving it back fixes it.
        pathlib.Path('foo2').rename(local_path)
        assert pathlib.Path(p['foo'].get_cached_path()) == local_path

        # Check that changing the contents invalidates the cache.
        local_path.write_text('omg')
        assert p['foo'].get_cached_path() is None

        # Check that installing the package again reuses the cached manifest and two objects - but not "foo".
        self.setup_s3_stubber_pkg_install(
            pkg_registry, pkg_name,
            entries=(
                ('s3://my_bucket/my_data_pkg/foo', '💩'.encode()),
            ),
        )

        with patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1):
            Package.install(pkg_name, registry=registry, dest='package/')

            # import works for installation outside named package directory
            with patch('quilt3.Package._browse') as browse_mock:
                browse_mock.return_value = quilt3.Package()
                from quilt3.data.Quilt import Foo

                assert isinstance(Foo, Package)
                browse_mock.assert_called_once()

        # make sure import works for an installed named package
        pkg_name2 = 'test/foo'
        same_manifest_path = (
            pkg_registry.manifest_pk(pkg_name2, self.default_test_top_hash) ==
            pkg_registry.manifest_pk(pkg_name, self.default_test_top_hash)
        )
        self.setup_s3_stubber_pkg_install(
            pkg_registry,
            pkg_name2,
            # Manifest is cached on PackageRegistryV1, since it's on the same path.
            manifest=None if same_manifest_path else REMOTE_MANIFEST.read_bytes(),
        )
        with patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1), \
             tempfile.TemporaryDirectory() as tmp_dir, \
             patch(
                 'quilt3.packages.get_install_location',
                 return_value=str(PhysicalKey.from_path(tmp_dir))
             ) as mocked_get_install_location:
            Package.install(pkg_name2, registry=registry)

            mocked_get_install_location.assert_called_once_with()
            items = []
            for dirpath, dirnames, filenames in os.walk(tmp_dir):
                dirpath = pathlib.Path(dirpath)
                for dirname in dirnames:
                    items.append((dirpath / dirname).relative_to(tmp_dir))
                for filename in filenames:
                    items.append((dirpath / filename).relative_to(tmp_dir))
            items.sort()
            assert items == list(map(pathlib.Path, (
                'test',
                'test/foo',
                'test/foo/bar.csv',
                'test/foo/baz',
                'test/foo/baz/bat',
                'test/foo/foo',
            )))

    def test_install_subpackage_deprecated_and_new(self):
        pkg_name = 'Quilt/Foo'
        bucket = 'my-test-bucket'
        path = 'baz'
        dest = 'package'

        with pytest.warns(RemovedInQuilt4Warning):
            with pytest.raises(ValueError):
                Package.install(f'{pkg_name}/{path}', registry=f's3://{bucket}', dest=dest, path=path)

    @pytest.mark.usefixtures('isolate_packages_cache')
    @patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1)
    @patch('quilt3.packages.ObjectPathCache.set')
    def test_install_subpackage_deprecated(self, mocked_cache_set):
        registry = 's3://my-test-bucket'
        pkg_registry = self.S3PackageRegistryDefault(PhysicalKey.from_url(registry))
        pkg_name = 'Quilt/Foo'
        subpackage_path = 'baz'
        entry_url = 's3://my_bucket/my_data_pkg/baz/bat'
        entry_content = b'42'
        entries = (
            (entry_url, entry_content),
        )
        dest = 'package'
        self.setup_s3_stubber_pkg_install(
            pkg_registry, pkg_name, manifest=REMOTE_MANIFEST.read_bytes(), entries=entries)

        with pytest.warns(RemovedInQuilt4Warning):
            Package.install(f'{pkg_name}/{subpackage_path}', registry=registry, dest=dest)

        path = pathlib.Path.cwd() / dest / 'bat'
        mocked_cache_set.assert_called_once_with(
            entry_url,
            PhysicalKey.from_path(path).path,
        )
        assert path.read_bytes() == entry_content

    @pytest.mark.usefixtures('isolate_packages_cache')
    @patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1)
    @patch('quilt3.packages.ObjectPathCache.set')
    def test_install_entry_deprecated(self, mocked_cache_set):
        registry = 's3://my-test-bucket'
        pkg_registry = self.S3PackageRegistryDefault(PhysicalKey.from_url(registry))
        pkg_name = 'Quilt/Foo'
        subpackage_path = 'baz/bat'
        entry_url = 's3://my_bucket/my_data_pkg/baz/bat'
        entry_content = b'42'
        entries = (
            (entry_url, entry_content),
        )
        dest = 'package'
        self.setup_s3_stubber_pkg_install(
            pkg_registry, pkg_name, manifest=REMOTE_MANIFEST.read_bytes(), entries=entries)

        with pytest.warns(RemovedInQuilt4Warning):
            Package.install(f'{pkg_name}/{subpackage_path}', registry=registry, dest=dest)

        path = pathlib.Path.cwd() / dest / 'bat'
        mocked_cache_set.assert_called_once_with(
            entry_url,
            PhysicalKey.from_path(path).path,
        )
        assert path.read_bytes() == entry_content

    @pytest.mark.usefixtures('isolate_packages_cache')
    @patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1)
    @patch('quilt3.packages.ObjectPathCache.set')
    def test_install_subpackage(self, mocked_cache_set):
        registry = 's3://my-test-bucket'
        pkg_registry = self.S3PackageRegistryDefault(PhysicalKey.from_url(registry))
        pkg_name = 'Quilt/Foo'
        path = 'baz'
        entry_url = 's3://my_bucket/my_data_pkg/baz/bat'
        entry_content = b'42'
        entries = (
            (entry_url, entry_content),
        )
        dest = 'package'
        self.setup_s3_stubber_pkg_install(
            pkg_registry, pkg_name, manifest=REMOTE_MANIFEST.read_bytes(), entries=entries)

        Package.install(pkg_name, registry=registry, dest=dest, path=path)

        path = pathlib.Path.cwd() / dest / 'bat'
        mocked_cache_set.assert_called_once_with(
            entry_url,
            PhysicalKey.from_path(path).path,
        )
        assert path.read_bytes() == entry_content

    @pytest.mark.usefixtures('isolate_packages_cache')
    @patch('quilt3.data_transfer.s3_transfer_config.max_request_concurrency', 1)
    @patch('quilt3.packages.ObjectPathCache.set')
    def test_install_entry(self, mocked_cache_set):
        registry = 's3://my-test-bucket'
        pkg_registry = self.S3PackageRegistryDefault(PhysicalKey.from_url(registry))
        pkg_name = 'Quilt/Foo'
        path = 'baz/bat'
        entry_url = 's3://my_bucket/my_data_pkg/baz/bat'
        entry_content = b'42'
        entries = (
            (entry_url, entry_content),
        )
        dest = 'package'
        self.setup_s3_stubber_pkg_install(
            pkg_registry, pkg_name, manifest=REMOTE_MANIFEST.read_bytes(), entries=entries)

        Package.install(pkg_name, registry=registry, dest=dest, path=path)

        path = pathlib.Path.cwd() / dest / 'bat'
        mocked_cache_set.assert_called_once_with(
            entry_url,
            PhysicalKey.from_path(path).path,
        )
        assert path.read_bytes() == entry_content

    def test_install_bad_name(self):
        with self.assertRaisesRegex(QuiltException, 'Invalid package name'):
            Package().install('?')

    def test_rollback(self):
        p = Package()
        p.set('foo', DATA_DIR / 'foo.txt')
        p.build('quilt/tmp')

        good_hash = p.top_hash

        assert 'foo' in Package.browse('quilt/tmp')

        p.delete('foo')
        p.build('quilt/tmp')

        assert 'foo' not in Package.browse('quilt/tmp')

        Package.rollback('quilt/tmp', LOCAL_REGISTRY, good_hash)

        assert 'foo' in Package.browse('quilt/tmp')

        with self.assertRaises(QuiltException):
            Package.rollback('quilt/tmp', LOCAL_REGISTRY, '12345678' * 8)

        with self.assertRaises(QuiltException):
            Package.rollback('quilt/blah', LOCAL_REGISTRY, good_hash)

    def test_rollback_none_registry(self):
        with pytest.raises(ValueError):
            Package.rollback('quilt/tmp', None, '12345678' * 8)

    def test_verify(self):
        self.patch_local_registry('shorten_top_hash', return_value='7a67ff4')
        pkg = Package()

        pkg.set('foo', b'Hello, World!')
        pkg.build('quilt/test')

        Package.install('quilt/test', LOCAL_REGISTRY, dest='test')
        assert pkg.verify('test')

        Path('test/blah').write_text('123')
        assert not pkg.verify('test')
        assert pkg.verify('test', extra_files_ok=True)

        Path('test/foo').write_text('123')
        assert not pkg.verify('test')
        assert not pkg.verify('test', extra_files_ok=True)

        Path('test/foo').write_text('Hello, World!')
        Path('test/blah').unlink()
        assert pkg.verify('test')

    @patch('quilt3.packages.calculate_sha256')
    def test_fix_sha256_fail(self, mocked_calculate_sha256):
        data = b'Hello, World!'
        pkg = Package()
        pkg.set('foo', data)
        _, entry = next(pkg.walk())

        exc = Exception('test exception')
        mocked_calculate_sha256.return_value = [exc]
        with pytest.raises(quilt3.exceptions.PackageException) as excinfo:
            pkg._fix_sha256()
        mocked_calculate_sha256.assert_called_once_with([entry.physical_key], [len(data)])
        assert entry.hash is None
        assert excinfo.value.__cause__ == exc

    @patch('quilt3.packages.calculate_sha256')
    def test_fix_sha256(self, mocked_calculate_sha256):
        data = b'Hello, World!'
        pkg = Package()
        pkg.set('foo', data)
        _, entry = next(pkg.walk())

        hash_ = object()
        mocked_calculate_sha256.return_value = [hash_]
        pkg._fix_sha256()
        mocked_calculate_sha256.assert_called_once_with([entry.physical_key], [len(data)])
        assert entry.hash == {'type': 'SHA256', 'value': hash_}

    def test_resolve_hash_invalid_pkg_name(self):
        with pytest.raises(QuiltException, match='Invalid package name'):
            Package.resolve_hash('?', Mock(), Mock())

    def _test_resolve_hash_without_pkg_name(self, hash_prefix, top_hash1):
        msg = r"Calling resolve_hash\(\) without the 'name' parameter is deprecated."
        with pytest.warns(RemovedInQuilt4Warning, match=msg):
            assert Package.resolve_hash(LOCAL_REGISTRY, hash_prefix) == top_hash1

    def test_resolve_hash(self):
        pkg_name = 'Quilt/Test'
        top_hash1 = 'top_hash11'
        top_hash2 = 'top_hash22'
        top_hash3 = 'top_hash13'
        hash_prefix = 'top_hash1'

        with pytest.raises(QuiltException, match='Found zero matches'):
            Package.resolve_hash(pkg_name, LOCAL_REGISTRY, hash_prefix)

        with patch('quilt3.Package.top_hash', top_hash1), \
             patch('time.time', return_value=1):
            Package().build(pkg_name)

        with patch('quilt3.Package.top_hash', top_hash2), \
             patch('time.time', return_value=2):
            Package().build(pkg_name)

        assert Package.resolve_hash(pkg_name, LOCAL_REGISTRY, hash_prefix) == top_hash1
        self._test_resolve_hash_without_pkg_name(hash_prefix, top_hash1)

        with patch('quilt3.Package.top_hash', top_hash3), \
             patch('time.time', return_value=3):
            Package().build(pkg_name)

        with pytest.raises(QuiltException, match='Found multiple matches'):
            Package.resolve_hash(pkg_name, LOCAL_REGISTRY, hash_prefix)

    @patch('quilt3.Package._fix_sha256', wraps=quilt3.Package._fix_sha256)
    @patch('quilt3.Package._build', wraps=quilt3.Package._build)
    def test_workflow_validation_error(self, build_mock, fix_hashes):
        self.patch_s3_registry('shorten_top_hash', return_value='7a67ff4')

        pkg = Package().set('foo', DATA_DIR / 'foo.txt')
        for method in (pkg.build, pkg.push):
            with self.subTest(method=method):
                with patch(
                    'quilt3.workflows.validate',
                    side_effect=Exception('test exception')
                ) as workflow_validate_mock:
                    with pytest.raises(Exception) as excinfo:
                        method('test/pkg', registry='s3://test-bucket')
                    assert excinfo.value is workflow_validate_mock.side_effect
                    workflow_validate_mock.assert_called_once()
                    assert not build_mock.mock_calls
                    assert not fix_hashes.mock_calls
                    assert pkg._workflow is None

    @patch('quilt3.packages.copy_file_list')
    @patch('quilt3.workflows.validate', return_value=mock.sentinel.returned_workflow)
    def test_workflow_validation(self, workflow_validate_mock, copy_file_list_mock):
        registry = 's3://test-bucket'
        pkg_registry = self.S3PackageRegistryDefault(PhysicalKey.from_url('s3://test-bucket'))
        self.patch_s3_registry('shorten_top_hash', return_value='7a67ff4')

        for method in (Package.build, Package.push):
            with self.subTest(method=method):
                with patch('quilt3.Package._build') as build_mock:
                    pkg = Package().set('foo', DATA_DIR / 'foo.txt')
                    method(pkg, 'test/pkg', registry)
                    workflow_validate_mock.assert_called_once_with(
                        registry=pkg_registry,
                        workflow=...,
                        meta={},
                        message=None,
                    )
                    assert pkg._workflow is mock.sentinel.returned_workflow
                    build_mock.assert_called_once()
                    workflow_validate_mock.reset_mock()
                    if method is Package.push:
                        copy_file_list_mock.assert_called_once()
                        copy_file_list_mock.reset_mock()

                with patch('quilt3.Package._build') as build_mock:
                    pkg = Package().set('foo', DATA_DIR / 'foo.txt').set_meta(mock.sentinel.pkg_meta)
                    method(
                        pkg,
                        'test/pkg',
                        registry,
                        workflow=mock.sentinel.workflow,
                        message=mock.sentinel.message,
                    )
                    workflow_validate_mock.assert_called_once_with(
                        registry=pkg_registry,
                        workflow=mock.sentinel.workflow,
                        meta=mock.sentinel.pkg_meta,
                        message=mock.sentinel.message,
                    )
                    assert pkg._workflow is mock.sentinel.returned_workflow
                    build_mock.assert_called_once()
                    workflow_validate_mock.reset_mock()
                    if method is Package.push:
                        copy_file_list_mock.assert_called_once()
                        copy_file_list_mock.reset_mock()


class PackageTestV2(PackageTest):
    default_registry_version = 2
    S3PackageRegistryDefault = S3PackageRegistryV2
    LocalPackageRegistryDefault = LocalPackageRegistryV2

    def _test_resolve_hash_without_pkg_name(self, hash_prefix, top_hash1):
        with pytest.raises(TypeError, match='Package name is required'):
            assert Package.resolve_hash(LOCAL_REGISTRY, hash_prefix) == top_hash1

    def local_manifest_timestamp_fixer(self, timestamp):
        wrapped = self.LocalPackageRegistryDefault.push_manifest

        def wrapper(pkg_registry, pkg_name, top_hash, manifest_data):
            wrapped(pkg_registry, pkg_name, top_hash, manifest_data)
            os.utime(pkg_registry._manifest_parent_pk(pkg_name, top_hash).path, (timestamp, timestamp))
        return patch.object(self.LocalPackageRegistryDefault, 'push_manifest', wrapper)

    def _test_list_remote_packages_setup_stubber(self, pkg_registry, *, pkg_names):
        self.s3_stubber.add_response(
            method='list_objects_v2',
            service_response={
                'CommonPrefixes': [
                    {'Prefix': pkg_registry.manifests_package_dir(pkg_name).path}
                    for pkg_name in pkg_names
                ]
            },
            expected_params={
                'Bucket': pkg_registry.root.bucket,
                'Prefix': pkg_registry.manifests_global_dir.path,
                'Delimiter': '/',
            }
        )

    def _test_remote_package_delete_setup_stubber(self, pkg_registry, pkg_name, *, pointers):
        top_hashes = (
            'e99b760a05539460ac0a7349abb8f476e8c75282a38845fa828f8a5d28374303',
            '20de5433549a4db332a11d8d64b934a82bdea8f144b4aecd901e7d4134f8e733',
        )
        self.s3_stubber.add_response(
            method='list_objects_v2',
            service_response={
                'Contents': [
                    {
                        'Key': pkg_registry.manifest_pk(pkg_name, top_hash).path,
                        'Size': 64,
                    }
                    for top_hash in top_hashes
                ]
            },
            expected_params={
                'Bucket': pkg_registry.root.bucket,
                'Prefix': pkg_registry.manifests_package_dir(pkg_name).path,
            }
        )
        for top_hash in top_hashes:
            self.s3_stubber.add_response(
                method='delete_object',
                service_response={},
                expected_params={
                    'Bucket': pkg_registry.root.bucket,
                    'Key': pkg_registry.manifest_pk(pkg_name, top_hash).path,
                }
            )
        super()._test_remote_package_delete_setup_stubber(pkg_registry, pkg_name, pointers=pointers)

    def _test_remote_revision_delete_setup_stubber(self, pkg_registry, pkg_name, *, top_hashes, latest, remove,
                                                   new_latest):
        self.s3_stubber.add_response(
            method='delete_object',
            service_response={},
            expected_params={
                'Bucket': pkg_registry.root.bucket,
                'Key': pkg_registry.manifest_pk(pkg_name, remove).path,
            }
        )
        self.setup_s3_stubber_resolve_pointer(pkg_registry, pkg_name, pointer='latest', top_hash=latest)
        if latest == remove:
            self.setup_s3_stubber_delete_pointer(pkg_registry, pkg_name, pointer='latest')
            self.s3_stubber.add_response(
                method='list_objects_v2',
                service_response={
                    'Contents': [
                        {
                            'Key': pkg_registry.manifest_pk(pkg_name, top_hash).path,
                            'Size': 64,
                            'LastModified': datetime.fromtimestamp(timestamp),
                        }
                        for top_hash, timestamp in top_hashes.items() if top_hash != remove
                    ]
                },
                expected_params={
                    'Bucket': pkg_registry.root.bucket,
                    'Prefix': pkg_registry.manifests_package_dir(pkg_name).path,
                }
            )
        if new_latest:
            self.s3_stubber.add_response(
                method='put_object',
                service_response={},
                expected_params={
                    'Body': new_latest.encode(),
                    'Bucket': pkg_registry.root.bucket,
                    'Key': pkg_registry.pointer_latest_pk(pkg_name).path,
                }
            )
        self.s3_stubber.add_response(
            method='list_objects_v2',
            service_response={
                'Contents': [],
            },
            expected_params={
                'Bucket': pkg_registry.root.bucket,
                'Prefix': pkg_registry.pointers_dir(pkg_name).path,
            }
        )


# The following tests were moved out of the PackageTest class to enable parametrization.
# see (https://docs.pytest.org/en/latest/unittest.html#pytest-features-in-unittest-testcase-subclasses)
@pytest.mark.parametrize(
    'target_dir, update_policy, expected_one_byte, expected_two_byte, expected_three_byte, expected_keys',
    [
        ('/', None, b'one', b'two', b'three', {'one.txt', 'two.txt', 'three.txt', 'sub'}),
        ('/', 'incoming', b'one', b'two', b'three', {'one.txt', 'two.txt', 'three.txt', 'sub'}),
        ('/', 'existing', b'1', b'two', b'three', {'one.txt', 'two.txt', 'three.txt', 'sub'}),
        ('', 'incoming', b'one', b'two', b'three', {'one.txt', 'two.txt', 'three.txt', 'sub'}),
        ('', 'existing', b'1', b'two', b'three', {'one.txt', 'two.txt', 'three.txt', 'sub'}),
        ('sub/', 'incoming', b'one', b'two', b'three', {'one.txt', 'sub'}),
        ('sub/', 'existing', b'one', b'2', b'3', {'one.txt', 'sub'}),
        ('new-sub/', 'incoming', b'one', b'two', b'three', {'one.txt', 'sub', 'new-sub'}),
        ('new-sub/', 'existing', b'one', b'two', b'three', {'one.txt', 'sub', 'new-sub'}),
        pytest.param('/', 'bad_policy', b'1', b'2', b'3', set(), marks=pytest.mark.xfail(raises=ValueError)),
    ]
)
def test_set_dir_update_policy(
    target_dir: str,
    update_policy: str,
    expected_one_byte: bytes,
    expected_two_byte: bytes,
    expected_three_byte: bytes,
    expected_keys: set
):
    """Verify building a package with update policy. """
    nested_dir = DATA_DIR / 'nested'
    pkg = Package()
    pkg.set_dir("/", nested_dir, meta={'name': 'test_meta'})
    assert set(pkg.keys()) == {'one.txt', 'sub'}
    assert set(pkg['sub'].keys()) == {'two.txt', 'three.txt'}
    assert pkg.meta == {'name': 'test_meta'}

    nested_dir_2 = DATA_DIR / 'nested2'
    if update_policy:
        pkg.set_dir(target_dir, nested_dir_2, update_policy=update_policy)
    else:
        pkg.set_dir(target_dir, nested_dir_2)
    assert set(pkg.keys()) == expected_keys

    target_dir = target_dir.strip("/")
    if target_dir:
        assert pkg['one.txt'].get_bytes() == b'1'
        assert set(pkg[target_dir].keys()) == {'one.txt', 'two.txt', 'three.txt'}
        assert pkg[target_dir + '/one.txt'].get_bytes() == expected_one_byte
        assert pkg[target_dir + '/two.txt'].get_bytes() == expected_two_byte
        assert pkg[target_dir + '/three.txt'].get_bytes() == expected_three_byte
    else:
        assert pkg['one.txt'].get_bytes() == expected_one_byte
        assert pkg['two.txt'].get_bytes() == expected_two_byte
        assert pkg['three.txt'].get_bytes() == expected_three_byte
        assert set(pkg['sub'].keys()) == {'two.txt', 'three.txt'}


@pytest.mark.parametrize(
    'update_policy, expected_a_url, expected_xy_url',
    [
        ('existing', 's3://bucket/foo/a.txt?versionId=xyz', 's3://bucket/foo/x/y.txt?versionId=null'),
        ('incoming', 's3://bucket/bar/a.txt?versionId=abc', 's3://bucket/bar/x/y.txt?versionId=null'),
        (None, 's3://bucket/bar/a.txt?versionId=abc', 's3://bucket/bar/x/y.txt?versionId=null')
    ]
)
def test_set_dir_update_policy_s3(update_policy, expected_a_url, expected_xy_url):
    with patch('quilt3.packages.list_object_versions') as list_object_versions_mock:
        list_object_versions_mock.return_value = (
            [
                dict(Key='foo/a.txt', VersionId='xyz', IsLatest=True, Size=10),
                dict(Key='foo/b.txt', VersionId='byc', IsLatest=True, Size=10),
                dict(Key='foo/x/y.txt', VersionId='null', IsLatest=True, Size=10),
                dict(Key='foo/z.txt', VersionId='123', IsLatest=False, Size=10),
            ],
            []
        )
        pkg = Package()
        pkg.set_dir('', 's3://bucket/foo/', meta={'name': 'test_meta'})
        assert 'c.txt' not in pkg.keys()
        assert pkg['a.txt'].get() == 's3://bucket/foo/a.txt?versionId=xyz'
        assert pkg['b.txt'].get() == 's3://bucket/foo/b.txt?versionId=byc'
        assert pkg['x/y.txt'].get() == 's3://bucket/foo/x/y.txt?versionId=null'
        list_object_versions_mock.assert_called_once_with('bucket', 'foo/')

        list_object_versions_mock.return_value = (
            [
                dict(Key='bar/a.txt', VersionId='abc', IsLatest=True, Size=10),
                dict(Key='bar/c.txt', VersionId='cyb', IsLatest=True, Size=10),
                dict(Key='bar/x/y.txt', VersionId='null', IsLatest=True, Size=10),
                dict(Key='bar/z.txt', VersionId='123', IsLatest=True, Size=10),
            ],
            []
        )
        if update_policy:
            pkg.set_dir('', 's3://bucket/bar', update_policy=update_policy)
        else:
            pkg.set_dir('', 's3://bucket/bar')
        assert pkg['a.txt'].get() == expected_a_url
        assert pkg['b.txt'].get() == 's3://bucket/foo/b.txt?versionId=byc'
        assert pkg['c.txt'].get() == 's3://bucket/bar/c.txt?versionId=cyb'
        assert pkg['x/y.txt'].get() == expected_xy_url
        assert pkg['z.txt'].get() == 's3://bucket/bar/z.txt?versionId=123'
        assert list_object_versions_mock.call_count == 2
        list_object_versions_mock.assert_has_calls([call('bucket', 'foo/'), call('bucket', 'bar/')])
