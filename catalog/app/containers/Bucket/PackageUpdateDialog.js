import cx from 'classnames'
import { FORM_ERROR } from 'final-form'
import pLimit from 'p-limit'
import * as R from 'ramda'
import * as React from 'react'
import { useDropzone } from 'react-dropzone'
import * as RF from 'react-final-form'
import { Link } from 'react-router-dom'
import * as M from '@material-ui/core'
import { fade } from '@material-ui/core/styles'

import * as APIConnector from 'utils/APIConnector'
import AsyncResult from 'utils/AsyncResult'
import * as AWS from 'utils/AWS'
import * as Data from 'utils/Data'
import Delay from 'utils/Delay'
import * as NamedRoutes from 'utils/NamedRoutes'
import StyledLink from 'utils/StyledLink'
import pipeThru from 'utils/pipeThru'
import * as s3paths from 'utils/s3paths'
import { readableBytes } from 'utils/string'
import tagged from 'utils/tagged'
import useMemoEq from 'utils/useMemoEq'
import * as validators from 'utils/validators'

import * as PD from './PackageDialog'
import * as ERRORS from './errors'
import * as requests from './requests'

const getNormalizedPath = (f) => (f.path.startsWith('/') ? f.path.substring(1) : f.path)

const TYPE_ORDER = ['added', 'modified', 'deleted', 'unchanged']

const useFilesInputStyles = M.makeStyles((t) => ({
  root: {
    marginTop: t.spacing(3),
  },
  header: {
    alignItems: 'center',
    display: 'flex',
    height: 24,
  },
  headerFiles: {
    ...t.typography.body1,
    display: 'flex',
  },
  headerFilesDisabled: {
    color: t.palette.text.secondary,
  },
  headerFilesError: {
    color: t.palette.error.main,
  },
  headerFilesWarn: {
    color: t.palette.warning.dark,
  },
  headerFilesAdded: {
    color: t.palette.success.main,
    marginLeft: t.spacing(0.5),
  },
  headerFilesDeleted: {
    color: t.palette.error.main,
    marginLeft: t.spacing(0.5),
  },
  dropzoneContainer: {
    marginTop: t.spacing(2),
    position: 'relative',
  },
  dropzone: {
    background: t.palette.action.hover,
    border: `1px solid ${t.palette.action.disabled}`,
    borderRadius: t.shape.borderRadius,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 140,
    outline: 'none',
    overflow: 'hidden',
  },
  dropzoneErr: {
    borderColor: t.palette.error.main,
  },
  dropzoneWarn: {
    borderColor: t.palette.warning.dark,
  },
  active: {
    background: t.palette.action.selected,
  },
  dropMsg: {
    ...t.typography.body2,
    alignItems: 'center',
    display: 'flex',
    flexGrow: 1,
    justifyContent: 'center',
    paddingBottom: t.spacing(1),
    paddingTop: t.spacing(1),
    textAlign: 'center',
  },
  dropMsgErr: {
    color: t.palette.error.main,
  },
  dropMsgWarn: {
    color: t.palette.warning.dark,
  },
  filesContainer: {
    borderBottom: `1px solid ${t.palette.action.disabled}`,
    maxHeight: 200,
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  filesContainerErr: {
    borderColor: t.palette.error.main,
  },
  filesContainerWarn: {
    borderColor: t.palette.warning.dark,
  },
  added: {},
  modified: {},
  deleted: {},
  unchanged: {},
  fileEntry: {
    alignItems: 'center',
    background: t.palette.background.paper,
    display: 'flex',
    '&:not(:last-child)': {
      borderBottomStyle: 'solid',
      borderBottomWidth: '1px',
      borderColor: 'inherit',
    },
    '&$added': {
      background: M.colors.green[100],
    },
    '&$modified': {
      background: M.colors.yellow[100],
    },
    '&$deleted': {
      background: M.colors.red[100],
    },
  },
  filePath: {
    ...t.typography.body2,
    flexGrow: 1,
    marginRight: t.spacing(1),
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileSize: {
    ...t.typography.body2,
    color: t.palette.text.secondary,
    marginRight: t.spacing(0.5),
  },
  lock: {
    alignItems: 'center',
    background: 'rgba(255,255,255,0.9)',
    border: `1px solid ${t.palette.action.disabled}`,
    borderRadius: t.shape.borderRadius,
    bottom: 0,
    cursor: 'not-allowed',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  progressContainer: {
    display: 'flex',
    position: 'relative',
  },
  progressPercent: {
    ...t.typography.h5,
    alignItems: 'center',
    bottom: 0,
    display: 'flex',
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  progressSize: {
    ...t.typography.body2,
    color: t.palette.text.secondary,
    marginTop: t.spacing(1),
  },
}))

function FilesInput({ input, meta, uploads, setUploads, errors = {} }) {
  const classes = useFilesInputStyles()

  const value = input.value || { added: {}, deleted: {}, existing: {} }
  const disabled = meta.submitting || meta.submitSucceeded
  const error = meta.submitFailed && meta.error

  const onInputChange = input.onChange

  const totalSize = React.useMemo(
    () => Object.values(value.added).reduce((sum, f) => sum + f.size, 0),
    [value.added],
  )

  const warn = totalSize > PD.MAX_SIZE

  // eslint-disable-next-line no-nested-ternary
  const label = error ? (
    errors[error] || error
  ) : warn ? (
    <>
      Total size of new files exceeds recommended maximum of {readableBytes(PD.MAX_SIZE)}
    </>
  ) : (
    'Drop files here or click to browse'
  )

  const pipeValue = useMemoEq([onInputChange, value], () => (...fns) =>
    R.pipe(...fns, onInputChange)(value),
  )

  const onDrop = React.useCallback(
    (files) => {
      if (disabled) return
      pipeValue(
        R.reduce(
          (acc, file) => {
            const path = getNormalizedPath(file)
            return R.evolve(
              {
                added: R.assoc(path, file),
                deleted: R.dissoc(path),
              },
              acc,
            )
          },
          R.__, // eslint-disable-line no-underscore-dangle
          files,
        ),
      )
    },
    [disabled, pipeValue],
  )

  const rm = (path) => {
    pipeValue(R.evolve({ added: R.dissoc(path) }))
    setUploads(R.dissoc(path))
  }

  const del = (path) => {
    pipeValue(R.evolve({ deleted: R.assoc(path, true) }))
  }

  const restore = (path) => {
    pipeValue(R.evolve({ deleted: R.dissoc(path) }))
  }

  const handleAction = (handler, ...args) => (e) => {
    e.stopPropagation()
    if (disabled) return
    handler(...args)
  }

  const revertFiles = React.useCallback(() => {
    if (disabled) return
    onInputChange(meta.initial)
    setUploads({})
  }, [disabled, onInputChange, setUploads, meta.initial])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop })

  const totalProgress = React.useMemo(() => getTotalProgress(uploads), [uploads])

  const computedEntries = useMemoEq(value, ({ added, deleted, existing }) => {
    const p1 = Object.entries(existing).map(([path, { size }]) => {
      if (path in deleted) {
        return { type: 'deleted', path, size }
      }
      if (path in added) {
        const a = added[path]
        return { type: 'modified', path, size: a.size, delta: a.size - size }
      }
      return { type: 'unchanged', path, size }
    })
    const p2 = Object.entries(added).reduce((acc, [path, { size }]) => {
      if (path in existing) return acc
      return acc.concat({ type: 'added', path, size })
    }, [])
    return R.sortBy((x) => [TYPE_ORDER.indexOf(x.type), x.path], p1.concat(p2))
  })

  const stats = useMemoEq(value, ({ added, deleted, existing }) => ({
    added: Object.values(added).reduce(
      (acc, f) => R.evolve({ count: R.inc, size: R.add(f.size) }, acc),
      { count: 0, size: 0 },
    ),
    deleted: Object.keys(deleted).reduce(
      (acc, path) => R.evolve({ count: R.inc, size: R.add(existing[path].size) }, acc),
      { count: 0, size: 0 },
    ),
  }))

  return (
    <div className={classes.root}>
      <div className={classes.header}>
        <div
          className={cx(
            classes.headerFiles,
            disabled // eslint-disable-line no-nested-ternary
              ? classes.headerFilesDisabled
              : error // eslint-disable-line no-nested-ternary
              ? classes.headerFilesError
              : warn
              ? classes.headerFilesWarn
              : undefined,
          )}
        >
          Files
          {(!!stats.added.count || !!stats.deleted.count) && (
            <>
              :
              {!!stats.added.count && (
                <span className={classes.headerFilesAdded}>
                  {' +'}
                  {stats.added.count} ({readableBytes(stats.added.size)})
                </span>
              )}
              {!!stats.deleted.count && (
                <span className={classes.headerFilesDeleted}>
                  {' -'}
                  {stats.deleted.count} ({readableBytes(stats.deleted.size)})
                </span>
              )}
              {warn && <M.Icon style={{ marginLeft: 4 }}>error_outline</M.Icon>}
            </>
          )}
        </div>
        <M.Box flexGrow={1} />
        {meta.dirty && (
          <M.Button
            onClick={revertFiles}
            disabled={disabled}
            size="small"
            endIcon={<M.Icon fontSize="small">restore</M.Icon>}
          >
            Revert files
          </M.Button>
        )}
      </div>

      <div className={classes.dropzoneContainer}>
        <div
          {...getRootProps({
            className: cx(
              classes.dropzone,
              isDragActive && !disabled && classes.active,
              !!error && classes.dropzoneErr,
              !error && warn && classes.dropzoneWarn,
            ),
          })}
        >
          <input {...getInputProps()} />

          {!!computedEntries.length && (
            <div
              className={cx(
                classes.filesContainer,
                !!error && classes.filesContainerErr,
                !error && warn && classes.filesContainerWarn,
              )}
            >
              {computedEntries.map(({ type, path, size }) => {
                const action = {
                  added: { hint: 'Remove', icon: 'clear', handler: rm },
                  modified: { hint: 'Revert', icon: 'restore', handler: rm },
                  deleted: { hint: 'Restore', icon: 'restore', handler: restore },
                  unchanged: { hint: 'Delete', icon: 'clear', handler: del },
                }[type]
                return (
                  // TODO: dif display for dif types
                  // TODO: show delta for modified?
                  <div
                    key={`${type}:${path}`}
                    className={cx(classes.fileEntry, classes[type])}
                  >
                    <M.IconButton
                      onClick={handleAction(action.handler, path)}
                      title={action.hint}
                      size="small"
                    >
                      <M.Icon fontSize="inherit">{action.icon}</M.Icon>
                    </M.IconButton>
                    <div className={classes.filePath} title={path}>
                      {path}
                    </div>
                    <div className={classes.fileSize}>{readableBytes(size)}</div>
                  </div>
                )
              })}
            </div>
          )}

          <div
            className={cx(
              classes.dropMsg,
              !!error && classes.dropMsgErr,
              !error && warn && classes.dropMsgWarn,
            )}
          >
            {label}
          </div>
        </div>
        {disabled && (
          <div className={classes.lock}>
            {!!totalProgress.total && (
              <>
                <div className={classes.progressContainer}>
                  <M.CircularProgress
                    size={80}
                    value={totalProgress.percent}
                    variant="determinate"
                  />
                  <div className={classes.progressPercent}>{totalProgress.percent}%</div>
                </div>
                <div className={classes.progressSize}>
                  {readableBytes(totalProgress.loaded)}
                  {' / '}
                  {readableBytes(totalProgress.total)}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const getTotalProgress = R.pipe(
  R.values,
  R.reduce(
    (acc, { progress: p = {} }) => ({
      total: acc.total + (p.total || 0),
      loaded: acc.loaded + (p.loaded || 0),
    }),
    { total: 0, loaded: 0 },
  ),
  (p) => ({
    ...p,
    percent: p.total ? Math.floor((p.loaded / p.total) * 100) : 100,
  }),
)

function DialogForm({
  bucket,
  name: initialName,
  close,
  onSuccess,
  setSubmitting,
  manifest,
  workflowsConfig,
}) {
  const s3 = AWS.S3.use()
  const req = APIConnector.use()
  const [uploads, setUploads] = React.useState({})
  const nameValidator = PD.useNameValidator()

  const initialMeta = React.useMemo(
    () => ({
      mode: 'kv',
      text: JSON.stringify(manifest.meta || {}),
    }),
    [manifest.meta],
  )

  const initialFiles = React.useMemo(
    () => ({ existing: manifest.entries, added: {}, deleted: {} }),
    [manifest.entries],
  )

  const initialWorkflow = React.useMemo(() => {
    const slug = manifest.workflow && manifest.workflow.id
    // reuse workflow from previous revision if it's still present in the config
    if (slug) {
      const w = workflowsConfig.workflows.find(R.propEq('slug', slug))
      if (w) return w
    }
    return PD.defaultWorkflowFromConfig(workflowsConfig)
  }, [manifest, workflowsConfig])

  const totalProgress = React.useMemo(() => getTotalProgress(uploads), [uploads])

  // eslint-disable-next-line consistent-return
  const onSubmit = async ({ name, msg, files, meta, workflow }) => {
    const toUpload = Object.entries(files.added).map(([path, file]) => ({ path, file }))

    const limit = pLimit(2)
    let rejected = false
    const uploadStates = toUpload.map(({ path, file }) => {
      // reuse state if file hasnt changed
      const entry = uploads[path]
      if (entry && entry.file === file) return { ...entry, path }

      const upload = s3.upload(
        {
          Bucket: bucket,
          Key: `${name}/${path}`,
          Body: file,
        },
        {
          queueSize: 2,
        },
      )
      upload.on('httpUploadProgress', ({ loaded }) => {
        if (rejected) return
        setUploads(R.assocPath([path, 'progress', 'loaded'], loaded))
      })
      const promise = limit(async () => {
        if (rejected) {
          setUploads(R.dissoc(path))
          return
        }
        const resultP = upload.promise()
        const hashP = PD.hashFile(file)
        try {
          // eslint-disable-next-line consistent-return
          return { result: await resultP, hash: await hashP }
        } catch (e) {
          rejected = true
          setUploads(R.dissoc(path))
          throw e
        }
      })
      return { path, file, upload, promise, progress: { total: file.size, loaded: 0 } }
    })

    pipeThru(uploadStates)(
      R.map(({ path, ...rest }) => ({ [path]: rest })),
      R.mergeAll,
      setUploads,
    )

    let uploaded
    try {
      uploaded = await Promise.all(uploadStates.map((x) => x.promise))
    } catch (e) {
      return { [FORM_ERROR]: 'Error uploading files' }
    }

    const newEntries = pipeThru(toUpload, uploaded)(
      R.zipWith((f, u) => [
        f.path,
        {
          physicalKey: s3paths.handleToS3Url({
            bucket,
            key: u.result.Key,
            version: u.result.VersionId,
          }),
          size: f.file.size,
          hash: u.hash,
        },
      ]),
      R.fromPairs,
    )

    const contents = pipeThru(files.existing)(
      R.omit(Object.keys(files.deleted)),
      R.mergeLeft(newEntries),
      R.toPairs,
      R.map(([path, data]) => ({
        logical_key: path,
        physical_key: data.physicalKey,
        size: data.size,
        hash: data.hash,
        meta: data.meta,
      })),
      R.sortBy(R.prop('logical_key')),
    )

    try {
      const res = await req({
        endpoint: '/packages',
        method: 'POST',
        body: {
          name,
          registry: `s3://${bucket}`,
          message: msg,
          contents,
          meta: PD.getMetaValue(meta),
          workflow: PD.getWorkflowApiParam(workflow.slug),
        },
      })
      onSuccess({ name, revision: res.timestamp })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('error creating manifest', e)
      // TODO: see if we should use e.message
      // TODO: handle specific cases?
      return { [FORM_ERROR]: 'Error creating manifest' }
    }
  }

  const onSubmitWrapped = async (...args) => {
    setSubmitting(true)
    try {
      return await onSubmit(...args)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <RF.Form onSubmit={onSubmitWrapped}>
      {({
        handleSubmit,
        submitting,
        submitFailed,
        error,
        submitError,
        hasValidationErrors,
        form,
        values,
      }) => (
        <>
          <M.DialogTitle>Push package revision</M.DialogTitle>
          <M.DialogContent style={{ paddingTop: 0 }}>
            <form onSubmit={handleSubmit}>
              <RF.Field
                component={PD.Field}
                name="name"
                label="Name"
                placeholder="Enter a package name"
                validate={validators.composeAsync(
                  validators.required,
                  nameValidator.validate,
                )}
                validateFields={['name']}
                errors={{
                  required: 'Enter a package name',
                  invalid: 'Invalid package name',
                }}
                margin="normal"
                fullWidth
                initialValue={initialName}
              />

              <RF.Field
                component={PD.Field}
                name="msg"
                label="Commit message"
                placeholder="Enter a commit message"
                validate={validators.required}
                validateFields={['msg']}
                errors={{
                  required: 'Enter a commit message',
                }}
                fullWidth
                margin="normal"
              />

              <RF.Field
                component={FilesInput}
                name="files"
                validate={validators.nonEmpty}
                validateFields={['files']}
                errors={{
                  nonEmpty: 'Add files to create a package',
                }}
                uploads={uploads}
                setUploads={setUploads}
                isEqual={R.equals}
                initialValue={initialFiles}
              />

              <PD.SchemaFetcher
                schemaUrl={R.pathOr('', ['schema', 'url'], values.workflow)}
              >
                {AsyncResult.case({
                  Ok: ({ responseError, schema, validate }) => (
                    <RF.Field
                      component={PD.MetaInput}
                      name="meta"
                      bucket={bucket}
                      schema={schema}
                      schemaError={responseError}
                      validate={validate}
                      isEqual={R.equals}
                      initialValue={initialMeta}
                    />
                  ),
                  _: () => <PD.MetaInputSkeleton />,
                })}
              </PD.SchemaFetcher>

              <RF.Field
                component={PD.WorkflowInput}
                name="workflow"
                workflowsConfig={workflowsConfig}
                initialValue={initialWorkflow}
                validateFields={['meta', 'workflow']}
              />

              <input type="submit" style={{ display: 'none' }} />
            </form>
          </M.DialogContent>
          <M.DialogActions>
            {submitting && (
              <Delay ms={200} alwaysRender>
                {(ready) => (
                  <M.Fade in={ready}>
                    <M.Box flexGrow={1} display="flex" alignItems="center" pl={2}>
                      <M.CircularProgress
                        size={24}
                        variant={
                          totalProgress.percent < 100 ? 'determinate' : 'indeterminate'
                        }
                        value={
                          totalProgress.percent < 100
                            ? totalProgress.percent * 0.9
                            : undefined
                        }
                      />
                      <M.Box pl={1} />
                      <M.Typography variant="body2" color="textSecondary">
                        {totalProgress.percent < 100
                          ? 'Uploading files'
                          : 'Writing manifest'}
                      </M.Typography>
                    </M.Box>
                  </M.Fade>
                )}
              </Delay>
            )}

            {!submitting && (!!error || !!submitError) && (
              <M.Box flexGrow={1} display="flex" alignItems="center" pl={2}>
                <M.Icon color="error">error_outline</M.Icon>
                <M.Box pl={1} />
                <M.Typography variant="body2" color="error">
                  {error || submitError}
                </M.Typography>
              </M.Box>
            )}

            <M.Button onClick={close} disabled={submitting}>
              Cancel
            </M.Button>
            <M.Button
              onClick={handleSubmit}
              variant="contained"
              color="primary"
              disabled={submitting || (submitFailed && hasValidationErrors)}
            >
              Push
            </M.Button>
          </M.DialogActions>
        </>
      )}
    </RF.Form>
  )
}

function DialogPlaceholder({ close }) {
  return (
    <>
      <M.DialogTitle>Push package revision</M.DialogTitle>
      <M.DialogContent style={{ paddingTop: 0 }}>
        <PD.FormSkeleton />
      </M.DialogContent>
      <M.DialogActions>
        <M.Button onClick={close}>Cancel</M.Button>
        <M.Button variant="contained" color="primary" disabled>
          Push
        </M.Button>
      </M.DialogActions>
    </>
  )
}

const errorDisplay = R.cond([
  [
    R.is(ERRORS.ManifestTooLarge),
    (e) => (
      <>
        <M.Typography variant="h6" gutterBottom>
          Package manifest too large
        </M.Typography>
        <M.Typography gutterBottom>
          This package is not editable via the web UI&mdash;it cannot handle package
          manifest that large ({readableBytes(e.actualSize)}).
        </M.Typography>
        <M.Typography>Please use Quilt CLI to edit this package.</M.Typography>
      </>
    ),
  ],
  [
    R.T,
    () => (
      <>
        <M.Typography variant="h6" gutterBottom>
          Unexpeceted error
        </M.Typography>
        <M.Typography gutterBottom>
          Something went wrong. Please contact Quilt support.
        </M.Typography>
        <M.Typography>You can also use Quilt CLI to edit this package.</M.Typography>
      </>
    ),
  ],
])

const useDialogErrorStyles = M.makeStyles((t) => ({
  overlay: {
    background: fade(t.palette.common.white, 0.4),
    bottom: 0,
    display: 'flex',
    flexDirection: 'column',
    left: 0,
    padding: t.spacing(2, 3, 4),
    position: 'absolute',
    right: 0,
    top: 0,
  },
}))

function DialogError({ error, close }) {
  const classes = useDialogErrorStyles()
  return (
    <>
      <M.DialogTitle>Push package revision</M.DialogTitle>
      <M.DialogContent style={{ paddingTop: 0, position: 'relative' }}>
        <PD.FormSkeleton animate={false} />
        <div className={classes.overlay}>{errorDisplay(error)}</div>
      </M.DialogContent>
      <M.DialogActions>
        <M.Button onClick={close}>Cancel</M.Button>
        <M.Button variant="contained" color="primary" disabled>
          Push
        </M.Button>
      </M.DialogActions>
    </>
  )
}

function DialogSuccess({ bucket, name, revision, close }) {
  const { urls } = NamedRoutes.use()
  return (
    <>
      <M.DialogTitle>Push complete</M.DialogTitle>
      <M.DialogContent style={{ paddingTop: 0 }}>
        <M.Typography>
          Package revision{' '}
          <StyledLink to={urls.bucketPackageTree(bucket, name, revision)}>
            {name}@{revision}
          </StyledLink>{' '}
          successfully created
        </M.Typography>
      </M.DialogContent>
      <M.DialogActions>
        <M.Button onClick={close}>Close</M.Button>
        <M.Button
          component={Link}
          to={urls.bucketPackageTree(bucket, name, revision)}
          variant="contained"
          color="primary"
        >
          Browse
        </M.Button>
      </M.DialogActions>
    </>
  )
}

function DialogWrapper({ exited, ...props }) {
  const ref = React.useRef()
  ref.current = { exited, onExited: props.onExited }
  React.useEffect(
    () => () => {
      // call onExited on unmount if it has not been called yet
      if (!ref.current.exited && ref.current.onExited) ref.current.onExited()
    },
    [],
  )
  return <M.Dialog {...props} />
}

const DialogState = tagged([
  'Closed',
  'Loading',
  'Error',
  'Form', // { manifest, workflowsConfig }
  'Success', // { name, revision }
])

export function usePackageUpdateDialog({ bucket, name, revision, onExited }) {
  const s3 = AWS.S3.use()

  const [isOpen, setOpen] = React.useState(false)
  const [wasOpened, setWasOpened] = React.useState(false)
  const [exited, setExited] = React.useState(!isOpen)
  const [exitValue, setExitValue] = React.useState(null)
  const [success, setSuccess] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [key, setKey] = React.useState(1)

  const manifestData = Data.use(
    requests.loadManifest,
    { s3, bucket, name, revision, key },
    { noAutoFetch: !wasOpened },
  )
  const workflowsData = Data.use(requests.workflowsList, { s3, bucket })

  const open = React.useCallback(() => {
    setOpen(true)
    setWasOpened(true)
    setExited(false)
  }, [setOpen, setWasOpened, setExited])

  const close = React.useCallback(() => {
    if (submitting) return
    setOpen(false)
    setExitValue({ pushed: success })
  }, [submitting, setOpen, success, setExitValue])

  const refreshManifest = React.useCallback(() => {
    setWasOpened(false)
    setKey(R.inc)
  }, [setWasOpened, setKey])

  const handleExited = React.useCallback(() => {
    setExited(true)
    setSuccess(false)
    setExitValue(null)
    if (onExited) {
      const shouldRefreshManifest = onExited(exitValue)
      if (shouldRefreshManifest) refreshManifest()
    }
  }, [setExited, setSuccess, setExitValue, onExited, exitValue, refreshManifest])

  const state = React.useMemo(() => {
    if (exited) return DialogState.Closed()
    if (success) return DialogState.Success(success)
    return workflowsData.case({
      Ok: (workflowsConfig) =>
        manifestData.case({
          Ok: (manifest) => DialogState.Form({ manifest, workflowsConfig }),
          Err: DialogState.Error,
          _: DialogState.Loading,
        }),
      Err: DialogState.Error,
      _: DialogState.Loading,
    })
  }, [exited, success, workflowsData, manifestData])

  const stateCase = React.useCallback((cases) => DialogState.case(cases, state), [state])

  const render = React.useCallback(
    () => (
      <DialogWrapper
        open={isOpen}
        exited={exited}
        onClose={close}
        fullWidth
        scroll="body"
        onExited={handleExited}
      >
        {stateCase({
          Closed: () => null,
          Loading: () => <DialogPlaceholder close={close} />,
          Error: (e) => <DialogError close={close} error={e} />,
          Form: (props) => (
            <DialogForm
              {...{
                bucket,
                name,
                close,
                onSuccess: setSuccess,
                setSubmitting,
                ...props,
              }}
            />
          ),
          Success: (props) => <DialogSuccess {...{ bucket, close, ...props }} />,
        })}
      </DialogWrapper>
    ),
    [bucket, name, isOpen, exited, close, stateCase, handleExited],
  )

  return React.useMemo(() => ({ open, close, render }), [open, close, render])
}

export const use = usePackageUpdateDialog
