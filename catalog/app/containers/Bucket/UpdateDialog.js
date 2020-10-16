import cx from 'classnames'
import { FORM_ERROR } from 'final-form'
import pLimit from 'p-limit'
import * as R from 'ramda'
import * as React from 'react'
import { useDropzone } from 'react-dropzone'
import * as RF from 'react-final-form'
import { Link } from 'react-router-dom'
import * as M from '@material-ui/core'
import * as Lab from '@material-ui/lab'

import * as APIConnector from 'utils/APIConnector'
import * as AWS from 'utils/AWS'
import * as Data from 'utils/Data'
import Delay from 'utils/Delay'
import * as NamedRoutes from 'utils/NamedRoutes'
import StyledLink from 'utils/StyledLink'
import pipeThru from 'utils/pipeThru'
import * as s3paths from 'utils/s3paths'
import { readableBytes } from 'utils/string'
import useMemoEq from 'utils/useMemoEq'
import * as validators from 'utils/validators'

import * as requests from './requests'

// const MAX_SIZE = 1000 * 1000 * 1000 // 1GB

const getNormalizedPath = (f) => (f.path.startsWith('/') ? f.path.substring(1) : f.path)

function Field({ input, meta, errors, label, ...rest }) {
  const error = meta.submitFailed && meta.error
  const validating = meta.submitFailed && meta.validating
  const props = {
    error: !!error,
    label: (
      <>
        {error ? errors[error] || error : label}
        {validating && <M.CircularProgress size={13} style={{ marginLeft: 8 }} />}
      </>
    ),
    disabled: meta.submitting || meta.submitSucceeded,
    InputLabelProps: { shrink: true },
    ...input,
    ...rest,
  }
  return <M.TextField {...props} />
}

const TYPE_ORDER = ['added', 'modified', 'deleted', 'unchanged']

const useFilesInputStyles = M.makeStyles((t) => ({
  root: {
    marginTop: t.spacing(2),
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
  dropzoneContainer: {
    position: 'relative',
  },
  dropzone: {
    background: t.palette.action.hover,
    border: `1px solid ${t.palette.action.disabled}`,
    borderRadius: t.shape.borderRadius,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    marginTop: t.spacing(1),
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

function FilesInputPlaceholder() {
  // TODO
  return <M.CircularProgress />
}

function FilesInput({ input, meta, uploads, setUploads, previous, errors = {} }) {
  const classes = useFilesInputStyles()

  const value = input.value || { added: {}, deleted: {} }
  const disabled = meta.submitting || meta.submitSucceeded
  const error = meta.submitFailed && meta.error

  const onInputChange = input.onChange

  // const totalSize = React.useMemo(() => value.reduce((sum, f) => sum + f.file.size, 0), [
  // value,
  // ])

  // const warn = totalSize > MAX_SIZE
  const warn = false

  // eslint-disable-next-line no-nested-ternary
  const label = error
    ? errors[error] || error
    : warn
    ? 'Total file size exceeds recommended maximum of 1GB'
    : 'Drop files here or click to browse'

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
    onInputChange({ added: {}, deleted: {} })
    setUploads({})
  }, [disabled, onInputChange, setUploads])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop })

  const totalProgress = React.useMemo(() => getTotalProgress(uploads), [uploads])

  const computedEntries = useMemoEq([previous, value], ([prev, { added, deleted }]) => {
    const p1 = Object.entries(prev).map(([path, { size }]) => {
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
      if (path in prev) return acc
      return acc.concat({ type: 'added', path, size })
    }, [])
    return R.sortBy((x) => [TYPE_ORDER.indexOf(x.type), x.path], p1.concat(p2))
  })

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
          {/* TODO: granular stats
          !!value.length && (
            <>
              : {value.length} ({readableBytes(totalSize)})
              {warn && <M.Icon style={{ marginLeft: 4 }}>error_outline</M.Icon>}
            </>
          )
          */}
        </div>
        <M.Box flexGrow={1} />
        {(!R.isEmpty(value.deleted) || !R.isEmpty(value.added)) && (
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
            <div className={classes.progressContainer}>
              <M.CircularProgress
                size={80}
                value={totalProgress.percent}
                variant="determinate"
              />
              <div className={classes.progressPercent}>{totalProgress.percent}%</div>
            </div>
            <div className={classes.progressSize}>
              {readableBytes(totalProgress.loaded)} / {readableBytes(totalProgress.total)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const tryParse = (v) => {
  try {
    return JSON.parse(v)
  } catch (e) {
    return v
  }
}

const isParsable = (v) => {
  try {
    JSON.parse(v)
    return true
  } catch (e) {
    return false
  }
}

const tryUnparse = (v) =>
  typeof v === 'string' && !isParsable(v) ? v : JSON.stringify(v)

const fieldsToText = R.pipe(
  R.filter((f) => !!f.key.trim()),
  R.map((f) => [f.key, tryParse(f.value)]),
  R.fromPairs,
  (x) => JSON.stringify(x, null, 2),
)

const objToFields = R.pipe(
  R.defaultTo({}),
  Object.entries,
  R.map(([key, value]) => ({ key, value: tryUnparse(value) })),
)

const textToFields = R.pipe((t) => JSON.parse(t), objToFields)

function getMetaValue(value) {
  if (!value) return undefined

  const pairs =
    value.mode === 'json'
      ? pipeThru(value.text || '{}')((t) => JSON.parse(t), R.toPairs)
      : (value.fields || []).map((f) => [f.key, tryParse(f.value)])

  return pipeThru(pairs)(
    R.filter(([k]) => !!k.trim()),
    R.fromPairs,
    R.when(R.isEmpty, () => undefined),
  )
}

function validateMeta(value) {
  if (!value) return
  if (value.mode === 'json') {
    // eslint-disable-next-line consistent-return
    return validators.jsonObject(value.text)
  }
}

const useMetaInputStyles = M.makeStyles((t) => ({
  root: {
    marginTop: t.spacing(3),
  },
  header: {
    alignItems: 'center',
    display: 'flex',
    height: 24,
  },
  btn: {
    fontSize: 11,
    height: 24,
    paddingBottom: 0,
    paddingLeft: 7,
    paddingRight: 7,
    paddingTop: 0,
  },
  json: {
    marginTop: t.spacing(1),
  },
  jsonInput: {
    fontFamily: t.typography.monospace.fontFamily,
    '&::placeholder': {
      fontFamily: t.typography.fontFamily,
    },
  },
  add: {
    marginTop: t.spacing(2),
  },
  row: {
    alignItems: 'center',
    display: 'flex',
    marginTop: t.spacing(1),
  },
  sep: {
    ...t.typography.body1,
    marginLeft: t.spacing(1),
    marginRight: t.spacing(1),
  },
  key: {
    flexBasis: 100,
    flexGrow: 1,
  },
  value: {
    flexBasis: 100,
    flexGrow: 2,
  },
}))

const EMPTY_FIELD = { key: '', value: '' }

function MetaInputPlaceholder() {
  // TODO
  return <M.CircularProgress />
}

// TODO: warn on duplicate keys
function MetaInput({ input, meta, previous }) {
  const classes = useMetaInputStyles()
  const initial = React.useMemo(() => {
    const fields = objToFields(previous)
    return { fields, text: fieldsToText(fields), mode: 'kv' }
  }, [previous])
  const value = input.value || initial
  const error = meta.submitFailed && meta.error
  const disabled = meta.submitting || meta.submitSucceeded
  const onInputChange = input.onChange

  const changeMode = (mode) => {
    if (disabled) return
    onInputChange({ ...value, mode })
  }

  const changeFields = (newFields) => {
    if (disabled) return
    const fields = typeof newFields === 'function' ? newFields(value.fields) : newFields
    const text = fieldsToText(fields)
    onInputChange({ ...value, fields, text })
  }

  const changeText = (text) => {
    if (disabled) return
    let fields
    try {
      fields = textToFields(text)
    } catch (e) {
      fields = value.fields
    }
    onInputChange({ ...value, fields, text })
  }

  const handleModeChange = (e, m) => {
    if (!m) return
    changeMode(m)
  }

  const handleKeyChange = (i) => (e) => {
    changeFields(R.assocPath([i, 'key'], e.target.value))
  }

  const handleValueChange = (i) => (e) => {
    changeFields(R.assocPath([i, 'value'], e.target.value))
  }

  const addField = () => {
    changeFields(R.append(EMPTY_FIELD))
  }

  const rmField = (i) => () => {
    changeFields(R.pipe(R.remove(i, 1), R.when(R.isEmpty, R.append(EMPTY_FIELD))))
  }

  const handleTextChange = (e) => {
    changeText(e.target.value)
  }

  return (
    <div className={classes.root}>
      <div className={classes.header}>
        {/* eslint-disable-next-line no-nested-ternary */}
        <M.Typography color={disabled ? 'textSecondary' : error ? 'error' : undefined}>
          Metadata
        </M.Typography>
        <M.Box flexGrow={1} />
        <Lab.ToggleButtonGroup value={value.mode} exclusive onChange={handleModeChange}>
          <Lab.ToggleButton value="kv" className={classes.btn} disabled={disabled}>
            Key : Value
          </Lab.ToggleButton>
          <Lab.ToggleButton value="json" className={classes.btn} disabled={disabled}>
            JSON
          </Lab.ToggleButton>
        </Lab.ToggleButtonGroup>
      </div>
      {value.mode === 'kv' ? (
        <>
          {value.fields.map((f, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className={classes.row}>
              <M.TextField
                className={classes.key}
                onChange={handleKeyChange(i)}
                value={f.key}
                placeholder="Key"
                disabled={disabled}
              />
              <div className={classes.sep}>:</div>
              <M.TextField
                className={classes.value}
                onChange={handleValueChange(i)}
                value={f.value}
                placeholder="Value"
                disabled={disabled}
              />
              <M.IconButton
                size="small"
                onClick={rmField(i)}
                edge="end"
                disabled={disabled}
              >
                <M.Icon>close</M.Icon>
              </M.IconButton>
            </div>
          ))}
          <M.Button
            variant="outlined"
            size="small"
            onClick={addField}
            startIcon={<M.Icon>add</M.Icon>}
            className={classes.add}
            disabled={disabled}
          >
            Add field
          </M.Button>
        </>
      ) : (
        <M.TextField
          variant="outlined"
          size="small"
          className={classes.json}
          value={value.text}
          onChange={handleTextChange}
          placeholder="Enter JSON metadata if necessary"
          error={!!error}
          helperText={
            !!error &&
            {
              jsonObject: 'Metadata must be a valid JSON object',
            }[error]
          }
          fullWidth
          multiline
          rowsMax={10}
          InputProps={{ classes: { input: classes.jsonInput } }}
          disabled={disabled}
        />
      )}
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
    percent: p.total ? Math.floor((p.loaded / p.total) * 100) : undefined,
  }),
)

async function hashFile(file) {
  if (!window.crypto || !window.crypto.subtle || !window.crypto.subtle.digest) return
  try {
    const buf = await file.arrayBuffer()
    const hashBuf = await window.crypto.subtle.digest('SHA-256', buf)
    // eslint-disable-next-line consistent-return
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch (e) {
    // return undefined on error
  }
}

function useManifestData({ bucket, name }) {
  const s3 = AWS.S3.use()
  return Data.use(requests.loadManifest, { s3, bucket, name })
}

export function UpdateDialog({ bucket, name, open, onClose }) {
  const s3 = AWS.S3.use()
  const req = APIConnector.use()
  const { urls } = NamedRoutes.use()
  const [uploads, setUploads] = React.useState({})
  const [success, setSuccess] = React.useState(null)

  const manifestData = useManifestData({ bucket, name })

  const reset = (form) => () => {
    form.restart()
    setSuccess(null)
    setUploads({})
  }

  const handleClose = ({ submitting = false } = {}) => () => {
    if (submitting) return
    // TODO: ask to abort if in progress
    onClose()
  }

  const totalProgress = getTotalProgress(uploads)

  // eslint-disable-next-line consistent-return
  const onSubmit = async ({ msg, files, meta }) => {
    console.log('onSubmit', { msg, files, meta })

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
        const hashP = hashFile(file)
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

    const contents = manifestData.case({
      Ok: R.pipe(
        R.prop('entries'),
        R.omit(Object.keys(files.deleted)),
        R.mergeLeft(newEntries),
        R.toPairs,
        R.map(([path, data]) => ({
          logical_key: path,
          physical_key: data.physicalKey,
          size: data.size,
          hash: data.hash,
        })),
        R.sortBy(R.prop('logical_key')),
      ),
      _: () => {
        throw new Error('invariant violation') // TODO: better error
      },
    })

    try {
      const res = await req({
        endpoint: '/packages',
        method: 'POST',
        body: {
          name,
          registry: `s3://${bucket}`,
          message: msg,
          contents,
          meta: getMetaValue(meta),
        },
      })
      setSuccess({ name, revision: res.timestamp })
    } catch (e) {
      console.log('error creating manifest', e)
      // TODO: handle specific cases?
      return { [FORM_ERROR]: 'Error creating manifest' }
    }
  }

  return (
    <RF.Form onSubmit={onSubmit}>
      {({
        handleSubmit,
        submitting,
        submitFailed,
        error,
        submitError,
        hasValidationErrors,
        form,
      }) => (
        <M.Dialog
          open={open}
          onClose={handleClose({ submitting })}
          fullWidth
          scroll="body"
          onExited={reset(form)}
        >
          <M.DialogTitle>
            {success ? 'Push complete' : 'Push package revision'}
          </M.DialogTitle>
          {success ? (
            <>
              <M.DialogContent style={{ paddingTop: 0 }}>
                <M.Typography>
                  Package revision{' '}
                  <StyledLink
                    to={urls.bucketPackageTree(bucket, success.name, success.revision)}
                  >
                    {success.name}@{success.revision}
                  </StyledLink>{' '}
                  successfully created
                </M.Typography>
              </M.DialogContent>
              <M.DialogActions>
                <M.Button onClick={handleClose()}>Close</M.Button>
                <M.Button onClick={reset(form)}>New push</M.Button>
                <M.Button
                  component={Link}
                  to={urls.bucketPackageTree(bucket, success.name, success.revision)}
                  variant="contained"
                  color="primary"
                >
                  Browse
                </M.Button>
              </M.DialogActions>
            </>
          ) : (
            <>
              <M.DialogContent style={{ paddingTop: 0 }}>
                <form onSubmit={handleSubmit}>
                  <M.TextField label="Name" disabled value={name} fullWidth />

                  <RF.Field
                    component={Field}
                    name="msg"
                    label="Commit message"
                    placeholder="Enter a commit message"
                    validate={validators.required}
                    errors={{
                      required: 'Enter a commit message',
                    }}
                    fullWidth
                    margin="normal"
                  />

                  {manifestData.case({
                    Ok: (m) => (
                      <RF.Field
                        component={FilesInput}
                        name="files"
                        validate={validators.nonEmpty}
                        errors={{
                          nonEmpty: 'Add files to create a package',
                        }}
                        uploads={uploads}
                        setUploads={setUploads}
                        isEqual={R.equals}
                        previous={m.entries}
                      />
                    ),
                    _: () => <FilesInputPlaceholder />,
                    // TODO: handle err
                  })}

                  {manifestData.case({
                    Ok: (m) => (
                      <RF.Field
                        component={MetaInput}
                        name="meta"
                        validate={validateMeta}
                        isEqual={R.equals}
                        previous={m.meta}
                      />
                    ),
                    _: () => <MetaInputPlaceholder />,
                    // TODO: handle err
                  })}

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
                              totalProgress.percent < 100
                                ? 'determinate'
                                : 'indeterminate'
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

                <M.Button onClick={handleClose({ submitting })} disabled={submitting}>
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
        </M.Dialog>
      )}
    </RF.Form>
  )
}

export function useUpdateDialog({ bucket, name }) {
  const [isOpen, setOpen] = React.useState(false)

  const open = React.useCallback(() => {
    setOpen(true)
  }, [setOpen])

  const close = React.useCallback(() => {
    setOpen(false)
  }, [setOpen])

  const render = React.useCallback(
    () => <UpdateDialog {...{ bucket, name, open: isOpen, onClose: close }} />,
    [bucket, name, isOpen, close],
  )

  return React.useMemo(() => ({ open, close, render }), [open, close, render])
}

export const use = useUpdateDialog
