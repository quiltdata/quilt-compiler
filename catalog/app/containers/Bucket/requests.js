import { join as pathJoin } from 'path'

import * as dateFns from 'date-fns'
import sampleSize from 'lodash/fp/sampleSize'
import * as R from 'ramda'

import { SUPPORTED_EXTENSIONS as IMG_EXTS } from 'components/Thumbnail'
import { mkSearch } from 'utils/NamedRoutes'
import * as Resource from 'utils/Resource'
import pipeThru from 'utils/pipeThru'
import * as s3paths from 'utils/s3paths'
import tagged from 'utils/tagged'
import yaml from 'utils/yaml'

import * as errors from './errors'

function parseSchema(schemaSlug, schemas) {
  return {
    url: R.path([schemaSlug, 'url'], schemas),
  }
}

function parseWorkflow(workflowSlug, workflow, data) {
  return {
    description: workflow.description,
    isDefault: workflowSlug === data.default_workflow,
    name: workflow.name,
    schema: parseSchema(workflow.metadata_schema, data.schemas),
    slug: workflowSlug,
  }
}

export const workflowNotAvaliable = Symbol('not available')

export const workflowNotSelected = Symbol('not selected')

function getNoWorkflow(data, hasConfig) {
  return {
    isDefault: !data.default_workflow,
    slug: hasConfig ? workflowNotSelected : workflowNotAvaliable,
  }
}

const emptyWorkflowsConfig = {
  isRequired: false,
  workflows: [getNoWorkflow({}, false)],
}

function parseWorkflows(workflowsYaml) {
  const data = yaml(workflowsYaml)
  if (!data) return emptyWorkflowsConfig

  const { workflows } = data
  if (!workflows) return emptyWorkflowsConfig

  const workflowsList = Object.keys(workflows).map((slug) =>
    parseWorkflow(slug, workflows[slug], data),
  )
  if (!workflowsList.length) return emptyWorkflowsConfig

  const noWorkflow =
    data.is_workflow_required === false ? getNoWorkflow(data, true) : null

  return {
    isRequired: data.is_workflow_required,
    workflows: noWorkflow ? [noWorkflow, ...workflowsList] : workflowsList,
  }
}

const withErrorHandling = (fn, pairs) => (...args) =>
  fn(...args).catch(errors.catchErrors(pairs))

const promiseProps = (obj) =>
  Promise.all(Object.values(obj)).then(R.zipObj(Object.keys(obj)))

export const bucketListing = ({ s3, bucket, path = '', prefix }) =>
  s3
    .listObjectsV2({
      Bucket: bucket,
      Delimiter: '/',
      Prefix: path + (prefix || ''),
    })
    .promise()
    .then(
      R.applySpec({
        dirs: R.pipe(
          R.prop('CommonPrefixes'),
          R.pluck('Prefix'),
          R.filter((d) => d !== '/' && d !== '../'),
          R.uniq,
        ),
        files: R.pipe(
          R.prop('Contents'),
          // filter-out "directory-files" (files that match prefixes)
          R.filter(({ Key }) => Key !== path && !Key.endsWith('/')),
          R.map((i) => ({
            // TODO: expose VersionId?
            bucket,
            key: i.Key,
            modified: i.LastModified,
            size: i.Size,
            etag: i.ETag,
            archived: i.StorageClass === 'GLACIER' || i.StorageClass === 'DEEP_ARCHIVE',
          })),
        ),
        truncated: R.prop('IsTruncated'),
        bucket: () => bucket,
        path: () => path,
        prefix: () => prefix,
      }),
    )
    .catch(errors.catchErrors())

const MAX_BANDS = 10

export const bucketAccessCounts = async ({
  s3,
  analyticsBucket,
  bucket,
  today,
  window,
}) => {
  if (!analyticsBucket) throw new Error('bucketAccessCounts: "analyticsBucket" required')

  const dates = R.unfold(
    (daysLeft) => daysLeft >= 0 && [dateFns.subDays(today, daysLeft), daysLeft - 1],
    window,
  )

  try {
    return await s3Select({
      s3,
      Bucket: analyticsBucket,
      Key: `${ACCESS_COUNTS_PREFIX}/Exts.csv`,
      Expression: `
        SELECT ext, counts FROM s3object
        WHERE eventname = 'GetObject'
        AND bucket = '${sqlEscape(bucket)}'
      `,
      InputSerialization: {
        CSV: {
          FileHeaderInfo: 'Use',
          AllowQuotedRecordDelimiter: true,
        },
      },
    }).then(
      R.pipe(
        R.map((r) => {
          const recordedCounts = JSON.parse(r.counts)
          const { counts, total } = dates.reduce(
            (acc, date) => {
              const value = recordedCounts[dateFns.format(date, 'yyyy-MM-dd')] || 0
              const sum = acc.total + value
              return {
                total: sum,
                counts: acc.counts.concat({ date, value, sum }),
              }
            },
            { total: 0, counts: [] },
          )
          return { ext: r.ext && `.${r.ext}`, total, counts }
        }),
        R.filter((i) => i.total),
        R.sort(R.descend(R.prop('total'))),
        R.applySpec({
          byExt: R.identity,
          byExtCollapsed: (bands) => {
            if (bands.length <= MAX_BANDS) return bands
            const [other, rest] = R.partition((b) => b.ext === '', bands)
            const [toKeep, toMerge] = R.splitAt(MAX_BANDS - 1, rest)
            const merged = [...other, ...toMerge].reduce((acc, band) => ({
              ext: '',
              total: acc.total + band.total,
              counts: R.zipWith(
                (a, b) => ({
                  date: a.date,
                  value: a.value + b.value,
                  sum: a.sum + b.sum,
                }),
                acc.counts,
                band.counts,
              ),
            }))
            return R.sort(R.descend(R.prop('total')), toKeep.concat(merged))
          },
          combined: {
            total: R.reduce((sum, { total }) => sum + total, 0),
            counts: R.pipe(
              R.pluck('counts'),
              R.transpose,
              R.map(
                R.reduce(
                  (acc, { date, value, sum }) => ({
                    date,
                    value: acc.value + value,
                    sum: acc.sum + sum,
                  }),
                  { value: 0, sum: 0 },
                ),
              ),
            ),
          },
        }),
      ),
    )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('Unable to fetch bucket access counts:')
    // eslint-disable-next-line no-console
    console.error(e)
    return {
      byExt: [],
      byExtCollapsed: [],
      combined: { total: 0, counts: [] },
    }
  }
}

const parseDate = (d) => d && new Date(d)

const getOverviewBucket = (url) => s3paths.parseS3Url(url).bucket
const getOverviewPrefix = (url) => s3paths.parseS3Url(url).key
const getOverviewKey = (url, path) => pathJoin(getOverviewPrefix(url), path)

const processStats = R.applySpec({
  exts: R.pipe(
    R.path(['aggregations', 'exts', 'buckets']),
    R.map((i) => ({
      ext: i.key,
      objects: i.doc_count,
      bytes: i.size.value,
    })),
    R.sort(R.descend(R.prop('bytes'))),
  ),
  totalObjects: R.path(['hits', 'total']),
  totalBytes: R.path(['aggregations', 'totalBytes', 'value']),
  totalPackages: R.path(['aggregations', 'totalPackageHandles', 'value']),
})

export const bucketStats = async ({ req, s3, bucket, overviewUrl }) => {
  if (overviewUrl) {
    try {
      return await s3
        .getObject({
          Bucket: getOverviewBucket(overviewUrl),
          Key: getOverviewKey(overviewUrl, 'stats.json'),
        })
        .promise()
        .then((r) => JSON.parse(r.Body.toString('utf-8')))
        .then(processStats)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`Unable to fetch pre-rendered stats from '${overviewUrl}':`)
      // eslint-disable-next-line no-console
      console.error(e)
    }
  }

  try {
    return await req('/search', { index: `${bucket}*`, action: 'stats' }).then(
      processStats,
    )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('Unable to fetch live stats:')
    // eslint-disable-next-line no-console
    console.error(e)
  }

  throw new Error('Stats unavailable')
}

const fetchFileVersioned = async ({ s3, bucket, path, version }) => {
  const versionExists = await ensureObjectIsPresent({
    s3,
    bucket,
    key: path,
    version,
  })
  if (!versionExists) {
    throw new errors.VersionNotFound(
      `${path} for ${bucket} and version ${version} does not exist`,
    )
  }

  return s3
    .getObject({
      Bucket: bucket,
      Key: path,
      VersionId: version,
    })
    .promise()
}

const fetchFileLatest = async ({ s3, bucket, path }) => {
  const fileExists = await ensureObjectIsPresent({
    s3,
    bucket,
    key: path,
  })
  if (!fileExists) {
    throw new errors.FileNotFound(`${path} for ${bucket} does not exist`)
  }

  const versions = await objectVersions({
    s3,
    bucket,
    path,
  })
  const { id } = R.find(R.prop('isLatest'), versions)
  const version = id === 'null' ? undefined : id

  return fetchFileVersioned({ s3, bucket, path, version })
}

const fetchFile = R.ifElse(R.prop('version'), fetchFileVersioned, fetchFileLatest)

export const metadataSchema = async ({ s3, schemaUrl }) => {
  if (!schemaUrl) return null

  const { bucket, key, version } = s3paths.parseS3Url(schemaUrl)

  try {
    const response = await fetchFile({ s3, bucket, path: key, version })
    return JSON.parse(response.Body.toString('utf-8'))
  } catch (e) {
    if (e instanceof errors.FileNotFound || e instanceof errors.VersionNotFound) throw e

    // eslint-disable-next-line no-console
    console.log('Unable to fetch')
    // eslint-disable-next-line no-console
    console.error(e)
  }

  return null
}

const WORKFLOWS_CONFIG_PATH = '.quilt/workflows/config.yml'

export const workflowsList = async ({ s3, bucket }) => {
  try {
    const response = await fetchFile({ s3, bucket, path: WORKFLOWS_CONFIG_PATH })
    return parseWorkflows(response.Body.toString('utf-8'))
  } catch (e) {
    if (e instanceof errors.FileNotFound || e instanceof errors.VersionNotFound)
      return emptyWorkflowsConfig

    // eslint-disable-next-line no-console
    console.log('Unable to fetch')
    // eslint-disable-next-line no-console
    console.error(e)
  }

  return emptyWorkflowsConfig
}

const README_KEYS = ['README.md', 'README.txt', 'README.ipynb']
const SAMPLE_EXTS = [
  '*.parquet',
  '*.parquet.gz',
  '*.csv',
  '*.csv.gz',
  '*.tsv',
  '*.tsv.gz',
  '*.txt',
  '*.txt.gz',
  '*.vcf',
  '*.vcf.gz',
  '*.xls',
  '*.xls.gz',
  '*.xlsx',
  '*.xlsx.gz',
  '*.ipynb',
  '*.md',
  '*.pdf',
  '*.pdf.gz',
  '*.json',
  '*.json.gz',
]
const SAMPLE_SIZE = 20
const SUMMARIZE_KEY = 'quilt_summarize.json'
const MAX_IMGS = 100

export const ObjectExistence = tagged(['Exists', 'DoesNotExist'])

export async function getObjectExistence({ s3, bucket, key, version }) {
  const req = s3.headObject({ Bucket: bucket, Key: key, VersionId: version })
  try {
    const h = await req.promise()
    return ObjectExistence.Exists({
      bucket,
      key,
      version: h.VersionId,
      deleted: !!h.DeleteMarker,
      archived: h.StorageClass === 'GLACIER' || h.StorageClass === 'DEEP_ARCHIVE',
    })
  } catch (e) {
    if (e.code === 405 && version != null) {
      // assume delete marker when 405 and version is defined,
      // since GET and HEAD methods are not allowed on delete markers
      // (https://github.com/boto/botocore/issues/674)
      return ObjectExistence.Exists({ bucket, key, version, deleted: true })
    }
    if (e.code === 'BadRequest' && version != null) {
      // assume invalid version when 400 and version is defined
      return ObjectExistence.DoesNotExist()
    }
    if (e.code === 'NotFound') {
      const { headers } = req.response.httpResponse
      if (headers['x-amz-delete-marker'] === 'true') {
        return ObjectExistence.Exists({
          bucket,
          key,
          version: headers['x-amz-version-id'],
          deleted: true,
        })
      }
      return ObjectExistence.DoesNotExist()
    }
    throw e
  }
}

export const ensureObjectIsPresent = (...args) =>
  getObjectExistence(...args).then(
    ObjectExistence.case({
      Exists: ({ deleted, archived, ...h }) => (deleted || archived ? null : h),
      _: () => null,
    }),
  )

export const bucketSummary = async ({ s3, req, bucket, overviewUrl, inStack }) => {
  const handle = await ensureObjectIsPresent({ s3, bucket, key: SUMMARIZE_KEY })
  if (handle) {
    try {
      return await summarize({ s3, handle })
    } catch (e) {
      const display = `${handle.bucket}/${handle.key}`
      // eslint-disable-next-line no-console
      console.log(`Unable to fetch configured summary from '${display}':`)
      // eslint-disable-next-line no-console
      console.error(e)
    }
  }
  if (overviewUrl) {
    try {
      return await s3
        .getObject({
          Bucket: getOverviewBucket(overviewUrl),
          Key: getOverviewKey(overviewUrl, 'summary.json'),
        })
        .promise()
        .then(
          R.pipe(
            (r) => JSON.parse(r.Body.toString('utf-8')),
            R.path(['aggregations', 'other', 'keys', 'buckets']),
            R.map((b) => ({
              bucket,
              key: b.key,
              // eslint-disable-next-line no-underscore-dangle
              version: b.latestVersion.hits.hits[0]._source.version_id,
              lastModified: parseDate(b.lastModified),
              // eslint-disable-next-line no-underscore-dangle
              ext: b.latestVersion.hits.hits[0]._source.ext,
            })),
            R.sortWith([
              R.ascend((h) => SAMPLE_EXTS.indexOf(h.ext)),
              R.descend(R.prop('lastModified')),
            ]),
            R.take(SAMPLE_SIZE),
          ),
        )
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`Unable to fetch pre-rendered summary from '${overviewUrl}':`)
      // eslint-disable-next-line no-console
      console.error(e)
    }
  }
  if (inStack) {
    try {
      return await req('/search', { action: 'sample', index: bucket }).then(
        R.pipe(
          R.path(['hits', 'hits']),
          R.map((h) => {
            // eslint-disable-next-line no-underscore-dangle
            const s = (h.inner_hits.latest.hits.hits[0] || {})._source
            return (
              s && {
                bucket,
                key: s.key,
                version: s.version_id,
              }
            )
          }),
          R.filter(Boolean),
          R.take(SAMPLE_SIZE),
        ),
      )
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('Unable to fetch live summary:')
      // eslint-disable-next-line no-console
      console.error(e)
    }
  }
  try {
    return await s3
      .listObjectsV2({ Bucket: bucket })
      .promise()
      .then(
        R.pipe(
          R.path(['Contents']),
          R.filter(
            R.propSatisfies(
              R.allPass([
                R.complement(R.startsWith('.quilt/')),
                R.complement(R.startsWith('/')),
                R.complement(R.endsWith(SUMMARIZE_KEY)),
                // eslint-disable-next-line no-underscore-dangle
                R.complement(R.includes(R.__, README_KEYS)),
                R.anyPass(SAMPLE_EXTS.map(R.unary(R.endsWith))),
              ]),
              'Key',
            ),
          ),
          sampleSize(SAMPLE_SIZE),
          R.map(({ Key: key }) => ({ key, bucket })),
        ),
      )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('Unable to fetch summary from S3 listing:')
    // eslint-disable-next-line no-console
    console.error(e)
  }
  return []
}

export const bucketReadmes = ({ s3, bucket, overviewUrl }) =>
  promiseProps({
    forced:
      overviewUrl &&
      ensureObjectIsPresent({
        s3,
        bucket: getOverviewBucket(overviewUrl),
        key: getOverviewKey(overviewUrl, 'README.md'),
      }),
    discovered: Promise.all(
      README_KEYS.map((key) => ensureObjectIsPresent({ s3, bucket, key })),
    ).then(R.filter(Boolean)),
  })

export const bucketImgs = async ({ req, s3, bucket, overviewUrl, inStack }) => {
  if (overviewUrl) {
    try {
      return await s3
        .getObject({
          Bucket: getOverviewBucket(overviewUrl),
          Key: getOverviewKey(overviewUrl, 'summary.json'),
        })
        .promise()
        .then(
          R.pipe(
            (r) => JSON.parse(r.Body.toString('utf-8')),
            R.path(['aggregations', 'images', 'keys', 'buckets']),
            R.map((b) => ({
              bucket,
              key: b.key,
              // eslint-disable-next-line no-underscore-dangle
              version: b.latestVersion.hits.hits[0]._source.version_id,
            })),
          ),
        )
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`Unable to fetch images sample from '${overviewUrl}':`)
      // eslint-disable-next-line no-console
      console.error(e)
    }
  }
  if (inStack) {
    try {
      return await req('/search', { action: 'images', index: bucket }).then(
        R.pipe(
          R.path(['hits', 'hits']),
          R.map((h) => {
            // eslint-disable-next-line no-underscore-dangle
            const s = (h.inner_hits.latest.hits.hits[0] || {})._source
            return (
              s && {
                bucket,
                key: s.key,
                version: s.version_id,
              }
            )
          }),
          R.filter(Boolean),
          R.take(MAX_IMGS),
        ),
      )
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('Unable to fetch live images sample:')
      // eslint-disable-next-line no-console
      console.error(e)
    }
  }
  try {
    return await s3
      .listObjectsV2({ Bucket: bucket })
      .promise()
      .then(
        R.pipe(
          R.path(['Contents']),
          R.filter(
            (i) =>
              i.StorageClass !== 'GLACIER' &&
              i.StorageClass !== 'DEEP_ARCHIVE' &&
              !i.Key.startsWith('/') &&
              IMG_EXTS.some((e) => i.Key.toLowerCase().endsWith(e)),
          ),
          sampleSize(MAX_IMGS),
          R.map(({ Key: key }) => ({ key, bucket })),
        ),
      )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('Unable to fetch images sample from S3 listing:')
    // eslint-disable-next-line no-console
    console.error(e)
  }
  return []
}

export const objectVersions = ({ s3, bucket, path }) =>
  s3
    .listObjectVersions({ Bucket: bucket, Prefix: path })
    .promise()
    .then(
      R.pipe(
        ({ Versions, DeleteMarkers }) => Versions.concat(DeleteMarkers),
        R.filter((v) => v.Key === path),
        R.map((v) => ({
          isLatest: v.IsLatest || false,
          lastModified: v.LastModified,
          size: v.Size,
          id: v.VersionId,
          deleteMarker: v.Size == null,
          archived: v.StorageClass === 'GLACIER' || v.StorageClass === 'DEEP_ARCHIVE',
        })),
        R.sort(R.descend(R.prop('lastModified'))),
      ),
    )

export const objectMeta = ({ s3, bucket, path, version }) =>
  s3
    .headObject({
      Bucket: bucket,
      Key: path,
      VersionId: version,
    })
    .promise()
    .then(R.pipe(R.path(['Metadata', 'helium']), R.when(Boolean, JSON.parse)))

const isValidManifest = R.both(Array.isArray, R.all(R.is(String)))

export const summarize = async ({ s3, handle: inputHandle, resolveLogicalKey }) => {
  if (!inputHandle) return null
  const handle =
    resolveLogicalKey && inputHandle.logicalKey && !inputHandle.key
      ? await resolveLogicalKey(inputHandle.logicalKey)
      : inputHandle

  try {
    const file = await s3
      .getObject({
        Bucket: handle.bucket,
        Key: handle.key,
        VersionId: handle.version,
        // TODO: figure out caching issues
        IfMatch: handle.etag,
      })
      .promise()
    const json = file.Body.toString('utf-8')
    const manifest = JSON.parse(json)
    if (!isValidManifest(manifest)) {
      throw new Error('Invalid manifest: must be a JSON array of file links')
    }

    const resolvePath = (path) =>
      resolveLogicalKey && handle.logicalKey
        ? resolveLogicalKey(s3paths.resolveKey(handle.logicalKey, path)).catch((e) => {
            // eslint-disable-next-line no-console
            console.warn('Error resolving logical key for summary', { handle, path })
            // eslint-disable-next-line no-console
            console.error(e)
            return null
          })
        : {
            bucket: handle.bucket,
            key: s3paths.resolveKey(handle.key, path),
          }

    const handles = await Promise.all(
      manifest.map(
        R.pipe(
          Resource.parse,
          Resource.Pointer.case({
            Web: () => null, // web urls are not supported in this context
            S3: R.identity,
            S3Rel: resolvePath,
            Path: resolvePath,
          }),
        ),
      ),
    )
    return handles.filter((h) => h)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('Error loading summary:')
    // eslint-disable-next-line no-console
    console.error(e)
    return []
  }
}

const PACKAGES_PREFIX = '.quilt/named_packages/'
const MANIFESTS_PREFIX = '.quilt/packages/'

const fetchPackagesAccessCounts = async ({
  s3,
  analyticsBucket,
  bucket,
  today,
  window,
}) => {
  try {
    const records = await s3Select({
      s3,
      Bucket: analyticsBucket,
      Key: `${ACCESS_COUNTS_PREFIX}/Packages.csv`,
      Expression: `
        SELECT name, counts FROM s3object
        WHERE eventname = 'GetObject'
        AND bucket = '${sqlEscape(bucket)}'
      `,
      InputSerialization: {
        CSV: {
          FileHeaderInfo: 'Use',
          AllowQuotedRecordDelimiter: true,
        },
      },
    })

    return records.reduce((acc, r) => {
      const recordedCounts = JSON.parse(r.counts)

      const counts = R.times((i) => {
        const date = dateFns.subDays(today, window - i - 1)
        return {
          date,
          value: recordedCounts[dateFns.format(date, 'yyyy-MM-dd')] || 0,
        }
      }, window)

      const total = Object.values(recordedCounts).reduce(R.add, 0)

      return { ...acc, [r.name]: { counts, total } }
    }, {})
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('fetchPackagesAccessCounts : error caught')
    // eslint-disable-next-line no-console
    console.error(e)
    return {}
  }
}

// eslint-disable-next-line no-underscore-dangle
const isReserved = R.includes(R.__, '.+|{}[]()"\\#@&<>~')

const escapeReserved = (c) => `\\${c}`

const isLetter = (c) => c.toLowerCase() !== c.toUpperCase()

const bothCases = (c) => `(${c.toLowerCase()}|${c.toUpperCase()})`

const mkFilterQuery = (filter) =>
  filter
    ? {
        regexp: {
          handle: {
            value: pipeThru(filter)(
              R.unless(R.test(/[*?]/), (f) => `*${f}*`),
              R.map(
                R.cond([
                  [isLetter, bothCases],
                  [isReserved, escapeReserved],
                  [R.equals('*'), () => '.*'],
                  [R.equals('?'), () => '.{0,1}'],
                  [R.T, R.identity],
                ]),
              ),
              R.join(''),
            ),
          },
        },
      }
    : { match_all: {} }

export const countPackages = withErrorHandling(async ({ req, bucket, filter }) => {
  const body = {
    query: mkFilterQuery(filter),
    aggs: {
      total: {
        cardinality: { field: 'handle' },
      },
    },
  }
  const result = await req('/search', {
    index: `${bucket}_packages`,
    action: 'packages',
    body: JSON.stringify(body),
    size: 0,
  })
  return result.aggregations.total.value
})

export const listPackages = withErrorHandling(
  async ({
    req,
    s3,
    analyticsBucket,
    bucket,
    filter,
    sort = 'name', // name | modified
    perPage = 30,
    page = 1,
    today,
    analyticsWindow = 30,
  }) => {
    const countsP =
      analyticsBucket &&
      fetchPackagesAccessCounts({
        s3,
        analyticsBucket,
        bucket,
        today,
        window: analyticsWindow,
      })

    const body = {
      query: mkFilterQuery(filter),
      aggs: {
        packages: {
          composite: {
            // the limit is configured in ES cluster settings (search.max_buckets)
            size: 10000,
            sources: [
              {
                handle: {
                  terms: { field: 'handle' },
                },
              },
            ],
          },
          aggs: {
            modified: {
              max: { field: 'last_modified' },
            },
            sort: {
              bucket_sort: {
                sort: sort === 'modified' ? [{ modified: { order: 'desc' } }] : undefined,
                size: perPage,
                from: perPage * (page - 1),
              },
            },
          },
        },
      },
    }
    const result = await req('/search', {
      index: `${bucket}_packages`,
      action: 'packages',
      body: JSON.stringify(body),
      size: 0,
    })
    const packages = result.aggregations.packages.buckets.map((b) => ({
      name: b.key.handle,
      modified: new Date(b.modified.value),
      revisions: b.doc_count,
    }))

    if (!countsP) return packages
    const counts = await countsP
    return packages.map((p) => ({ ...p, views: counts[p.name] }))
  },
)

const getRevisionKeyFromId = (name, id) => `${PACKAGES_PREFIX}${name}/${id}`

export async function fetchRevisionsAccessCounts({
  s3,
  analyticsBucket,
  bucket,
  name,
  today,
  window,
}) {
  if (!analyticsBucket) return {}
  try {
    const records = await s3Select({
      s3,
      Bucket: analyticsBucket,
      Key: `${ACCESS_COUNTS_PREFIX}/PackageVersions.csv`,
      Expression: `
        SELECT hash, counts FROM s3object
        WHERE eventname = 'GetObject'
        AND bucket = '${sqlEscape(bucket)}'
        AND name = '${sqlEscape(name)}'
      `,
      InputSerialization: {
        CSV: {
          FileHeaderInfo: 'Use',
          AllowQuotedRecordDelimiter: true,
        },
      },
    })

    return records.reduce((acc, r) => {
      const recordedCounts = JSON.parse(r.counts)

      const counts = R.times((i) => {
        const date = dateFns.subDays(today, window - i - 1)
        return {
          date,
          value: recordedCounts[dateFns.format(date, 'yyyy-MM-dd')] || 0,
        }
      }, window)

      const total = Object.values(recordedCounts).reduce(R.add, 0)

      return { ...acc, [r.hash]: { counts, total } }
    }, {})
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('fetchRevisionsAccessCounts : error caught')
    // eslint-disable-next-line no-console
    console.error(e)
    return {}
  }
}

export const countPackageRevisions = ({ req, bucket, name }) =>
  req('/search', {
    index: `${bucket}_packages`,
    action: 'packages',
    body: JSON.stringify({ query: { term: { handle: name } } }),
    size: 0,
  })
    .then(R.path(['hits', 'total']))
    .catch(errors.catchErrors())

function tryParse(s) {
  try {
    return JSON.parse(s)
  } catch (e) {
    return undefined
  }
}

export const getPackageRevisions = withErrorHandling(
  ({ req, bucket, name, page = 1, perPage = 10 }) =>
    req('/search', {
      index: `${bucket}_packages`,
      action: 'packages',
      body: JSON.stringify({
        query: { term: { handle: name } },
        sort: [{ last_modified: 'desc' }],
      }),
      size: perPage,
      from: perPage * (page - 1),
      _source: [
        'comment',
        'hash',
        'last_modified',
        'metadata',
        'package_stats',
        'pointer_file', // TODO: rm after switching to hash-based routing
      ].join(','),
    }).then(
      R.pipe(
        R.path(['hits', 'hits']),
        R.map(({ _source: s }) => ({
          hash: s.hash,
          modified: new Date(s.last_modified),
          stats: {
            files: R.pathOr(0, ['package_stats', 'total_files'], s),
            bytes: R.pathOr(0, ['package_stats', 'total_bytes'], s),
          },
          message: s.comment,
          metadata: tryParse(s.metadata),
          id: s.pointer_file, // TODO: rm after switching to hash-based routing
          // header, // not in ES
        })),
      ),
    ),
)

export const loadRevisionHash = ({ s3, bucket, name, id }) =>
  s3
    .getObject({ Bucket: bucket, Key: getRevisionKeyFromId(name, id) })
    .promise()
    .then((res) => ({
      modified: res.LastModified,
      hash: res.Body.toString('utf-8'),
    }))

// TODO: Preview endpoint only allows up to 512 lines right now. Increase it to 1000.
const MAX_PACKAGE_ENTRIES = 500

export const getRevisionData = async ({
  s3,
  endpoint,
  sign,
  bucket,
  name,
  id,
  maxKeys = MAX_PACKAGE_ENTRIES,
}) => {
  const { hash, modified } = await loadRevisionHash({ s3, bucket, name, id })
  const manifestKey = `${MANIFESTS_PREFIX}${hash}`
  const url = sign({ bucket, key: manifestKey })
  const maxLines = maxKeys + 2 // 1 for the meta and 1 for checking overflow
  const r = await fetch(
    `${endpoint}/preview?url=${encodeURIComponent(url)}&input=txt&line_count=${maxLines}`,
  )
  const [header, ...entries] = await r
    .json()
    .then((json) => json.info.data.head.map((l) => JSON.parse(l)))
  const files = Math.min(maxKeys, entries.length)
  const bytes = entries.slice(0, maxKeys).reduce((sum, i) => sum + i.size, 0)
  const truncated = entries.length > maxKeys
  return {
    hash,
    modified,
    stats: { files, bytes, truncated },
    message: header.message,
    header,
  }
}

export async function loadManifest({ s3, bucket, name, revision = 'latest' }) {
  try {
    const { hash } = await loadRevisionHash({ s3, bucket, name, id: revision })
    const manifestKey = `${MANIFESTS_PREFIX}${hash}`
    // TODO: head request first
    // const h = await s3.headObject({ Bucket: bucket, Key: manifestKey }).promise()
    // check h.ContentLength
    const m = await s3.getObject({ Bucket: bucket, Key: manifestKey }).promise()
    const [header, ...rawEntries] = pipeThru(m.Body.toString('utf-8'))(
      R.split('\n'),
      R.map(tryParse),
      R.filter(Boolean),
    )
    const meta = header.user_meta
    const entries = pipeThru(rawEntries)(
      R.map((e) => [
        e.logical_key,
        { hash: e.hash.value, physicalKey: e.physical_keys[0], size: e.size },
      ]),
      R.fromPairs,
    )
    return { meta, entries }
  } catch (e) {
    console.log('loadManifest err', e)
    throw e
  }
}

const s3Select = ({
  s3,
  ExpressionType = 'SQL',
  InputSerialization = { JSON: { Type: 'LINES' } },
  ...rest
}) =>
  s3
    .selectObjectContent({
      ExpressionType,
      InputSerialization,
      OutputSerialization: { JSON: {} },
      ...rest,
    })
    .promise()
    .then(
      R.pipe(
        R.prop('Payload'),
        R.reduce((acc, evt) => {
          if (!evt.Records) return acc
          const s = evt.Records.Payload.toString()
          return acc + s
        }, ''),
        R.trim,
        R.ifElse(R.isEmpty, R.always([]), R.pipe(R.split('\n'), R.map(JSON.parse))),
      ),
    )

export async function packageSelect({
  s3,
  credentials,
  endpoint,
  bucket,
  name,
  revision,
  ...args
}) {
  const { hash } = await loadRevisionHash({ s3, bucket, name, id: revision })
  const manifest = `${MANIFESTS_PREFIX}${hash}`

  await credentials.getPromise()

  const r = await fetch(
    `${endpoint}/pkgselect${mkSearch({
      bucket,
      manifest,
      access_key: credentials.accessKeyId,
      secret_key: credentials.secretAccessKey,
      session_token: credentials.sessionToken,
      ...args,
    })}`,
  )

  if (r.status >= 400) {
    const msg = await r.text()
    // eslint-disable-next-line no-console
    console.error(`pkgselect error (${r.status}): ${msg}`)
    throw new errors.BucketError(msg, { status: r.status })
  }

  const json = await r.json()

  return R.evolve(
    {
      objects: R.map((o) => ({
        name: o.logical_key,
        physicalKey: o.physical_key,
        size: o.size,
      })),
      prefixes: R.pluck('logical_key'),
    },
    json.contents,
  )
}

export async function packageFileDetail({ path, ...args }) {
  const r = await packageSelect({ logical_key: path, ...args })
  return {
    ...s3paths.parseS3Url(r.physical_keys[0]),
    size: r.size,
    logicalKey: r.logical_key,
    meta: r.meta,
  }
}

const sqlEscape = (arg) => arg.replace(/'/g, "''")

const ACCESS_COUNTS_PREFIX = 'AccessCounts'

const queryAccessCounts = async ({
  s3,
  analyticsBucket,
  type,
  query,
  today,
  window = 365,
}) => {
  try {
    const records = await s3Select({
      s3,
      Bucket: analyticsBucket,
      Key: `${ACCESS_COUNTS_PREFIX}/${type}.csv`,
      Expression: query,
      InputSerialization: {
        CSV: {
          FileHeaderInfo: 'Use',
          AllowQuotedRecordDelimiter: true,
        },
      },
    })

    const recordedCounts = records.length ? JSON.parse(records[0].counts) : {}

    const counts = R.times((i) => {
      const date = dateFns.subDays(today, window - i - 1)
      return {
        date,
        value: recordedCounts[dateFns.format(date, 'yyyy-MM-dd')] || 0,
      }
    }, window)

    const total = Object.values(recordedCounts).reduce(R.add, 0)

    return { counts, total }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('queryAccessCounts: error caught')
    // eslint-disable-next-line no-console
    console.error(e)
    throw e
  }
}

export const objectAccessCounts = ({ s3, analyticsBucket, bucket, path, today }) =>
  queryAccessCounts({
    s3,
    analyticsBucket,
    type: 'Objects',
    query: `
      SELECT counts FROM s3object
      WHERE eventname = 'GetObject'
      AND bucket = '${sqlEscape(bucket)}'
      AND "key" = '${sqlEscape(path)}'
    `,
    today,
    window: 365,
  })
