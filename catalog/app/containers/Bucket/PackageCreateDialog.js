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

import JsonEditor from 'components/JsonEditor'
import { parseJSON, stringifyJSON, validateOnSchema } from 'components/JsonEditor/State'
import Skeleton from 'components/Skeleton'
import { useData } from 'utils/Data'
import AsyncResult from 'utils/AsyncResult'
import * as APIConnector from 'utils/APIConnector'
import * as AWS from 'utils/AWS'
import Delay from 'utils/Delay'
import * as NamedRoutes from 'utils/NamedRoutes'
import StyledLink from 'utils/StyledLink'
import pipeThru from 'utils/pipeThru'
import * as s3paths from 'utils/s3paths'
import { readableBytes } from 'utils/string'
import * as validators from 'utils/validators'

import SelectWorkflow from './SelectWorkflow'
import * as requests from './requests'

const MAX_SIZE = 1000 * 1000 * 1000 // 1GB
const ES_LAG = 3 * 1000

const Errors = {
  FILES_UPLOAD: { [FORM_ERROR]: 'Error uploading files' },
  PACKAGE_CREATION: { [FORM_ERROR]: 'Error creating manifest' },
  PACKAGE_VALIDATION: { [FORM_ERROR]: 'Error validating package' },
}

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
  fileEntry: {
    alignItems: 'center',
    background: t.palette.background.paper,
    display: 'flex',
    '&:not(:last-child)': {
      borderBottomStyle: 'solid',
      borderBottomWidth: '1px',
      borderColor: 'inherit',
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

function FilesInput({
  input: { value: inputValue, onChange: onInputChange },
  meta,
  uploads,
  setUploads,
  errors = {},
}) {
  const classes = useFilesInputStyles()

  const value = inputValue || []
  const disabled = meta.submitting || meta.submitSucceeded
  const error = meta.submitFailed && meta.error

  const totalSize = React.useMemo(() => value.reduce((sum, f) => sum + f.file.size, 0), [
    value,
  ])

  const warn = totalSize > MAX_SIZE

  // eslint-disable-next-line no-nested-ternary
  const label = error
    ? errors[error] || error
    : warn
    ? 'Total file size exceeds recommended maximum of 1GB'
    : 'Drop files here or click to browse'

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const onDrop = React.useCallback(
    disabled
      ? () => {}
      : R.pipe(
          R.reduce((entries, file) => {
            const path = getNormalizedPath(file)
            const idx = entries.findIndex(R.propEq('path', path))
            const put = idx === -1 ? R.append : R.update(idx)
            return put({ path, file }, entries)
          }, value),
          R.sortBy(R.prop('path')),
          onInputChange,
        ),
    [disabled, value, onInputChange],
  )

  const rmFile = ({ path }) => (e) => {
    e.stopPropagation()
    if (disabled) return
    pipeThru(value)(R.reject(R.propEq('path', path)), onInputChange)
    setUploads(R.dissoc(path))
  }

  const clearFiles = React.useCallback(() => {
    if (disabled) return
    onInputChange([])
    setUploads({})
  }, [disabled, setUploads, onInputChange])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop })

  const totalProgress = React.useMemo(() => getTotalProgress(uploads), [uploads])
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
          {!!value.length && (
            <>
              : {value.length} ({readableBytes(totalSize)})
              {warn && <M.Icon style={{ marginLeft: 4 }}>error_outline</M.Icon>}
            </>
          )}
        </div>
        <M.Box flexGrow={1} />
        {!!value.length && (
          <M.Button
            onClick={clearFiles}
            disabled={disabled}
            size="small"
            endIcon={<M.Icon fontSize="small">clear</M.Icon>}
          >
            clear files
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

          {!!value.length && (
            <div
              className={cx(
                classes.filesContainer,
                !!error && classes.filesContainerErr,
                !error && warn && classes.filesContainerWarn,
              )}
            >
              {value.map(({ file, path }) => (
                <div key={path} className={classes.fileEntry}>
                  <M.IconButton onClick={rmFile({ path })} size="small">
                    <M.Icon fontSize="inherit">clear</M.Icon>
                  </M.IconButton>
                  <div className={classes.filePath} title={path}>
                    {path}
                  </div>
                  <div className={classes.fileSize}>{readableBytes(file.size)}</div>
                </div>
              ))}
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

function getMetaValue(value) {
  if (!value) return undefined

  const pairs = pipeThru(value.text || '{}')((t) => JSON.parse(t), R.toPairs)

  return pipeThru(pairs)(
    R.filter(([k]) => !!k.trim()),
    R.fromPairs,
    R.when(R.isEmpty, () => undefined),
  )
}

function validateMeta(schema) {
  // TODO: move schema validation to utils/validators
  //       but don't forget that validation depends on library.
  //       Maybe we should split validators to files at first
  const schemaValidator = validateOnSchema(schema)
  return (value) => {
    const noError = undefined

    if (schema) {
      const obj = value ? parseJSON(value.text) : {}
      const errors = schemaValidator(obj)
      if (!errors.length) {
        return noError
      }

      return errors
    }

    if (!value) return noError

    if (value.mode === 'json') {
      return validators.jsonObject(value.text)
    }

    return noError
  }
}

function MetaInputSkeleton() {
  const classes = useMetaInputStyles()
  const t = M.useTheme()
  return (
    <M.Grid container spacing={1} className={classes.root}>
      {R.range(0, 6).map((index) => (
        <M.Grid item xs={6} key={index}>
          <Skeleton height={t.spacing(4)} width="100%" />
        </M.Grid>
      ))}
    </M.Grid>
  )
}

const useMetaInputStyles = M.makeStyles((t) => ({
  root: {
    marginTop: t.spacing(3),
  },
  header: {
    alignItems: 'center',
    display: 'flex',
    marginBottom: t.spacing(2),
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

const EMPTY_META_VALUE = {
  mode: 'kv',
  text: '{}',
}

// TODO: warn on duplicate keys
function MetaInput({ schemaError, input, meta, schema }) {
  const classes = useMetaInputStyles()
  const value = input.value || EMPTY_META_VALUE
  const error = schemaError ? [schemaError] : meta.submitFailed && meta.error
  const disabled = meta.submitting || meta.submitSucceeded

  const parsedValue = React.useMemo(() => {
    const obj = parseJSON(value.text)
    return R.is(Object, obj) && !Array.isArray(obj) ? obj : {}
  }, [value])

  const changeMode = (mode) => {
    if (disabled) return
    input.onChange({ ...value, mode })
  }

  const changeText = React.useCallback(
    (text) => {
      if (disabled) return
      input.onChange({ ...value, text })
    },
    [disabled, input, value],
  )

  const handleModeChange = (e, m) => {
    if (!m) return
    changeMode(m)
  }

  const handleTextChange = (e) => {
    changeText(e.target.value)
  }

  const onJsonEditor = React.useCallback((json) => changeText(stringifyJSON(json)), [
    changeText,
  ])

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
        <JsonEditor
          error={error}
          disabled={disabled}
          value={parsedValue}
          onChange={onJsonEditor}
          schema={schema}
        />
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

const cacheDebounce = (fn, wait, getKey = R.identity) => {
  const cache = {}
  let timer
  let resolveList = []

  return (...args) => {
    const key = getKey(...args)
    if (key in cache) return cache[key]

    return new Promise((resolveNew) => {
      clearTimeout(timer)

      timer = setTimeout(() => {
        timer = null

        const result = Promise.resolve(fn(...args))
        cache[key] = result

        resolveList.forEach((resolve) => resolve(result))

        resolveList = []
      }, wait)

      resolveList.push(resolveNew)
    })
  }
}

const useCounter = () => {
  const [value, setValue] = React.useState(0)
  const inc = React.useCallback(() => setValue(R.inc), [setValue])
  return React.useMemo(() => ({ value, inc }), [value, inc])
}

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

const useWorkflowInputStyles = M.makeStyles((t) => ({
  root: {
    margin: t.spacing(2, 0, 3),
  },
  select: {
    marginTop: t.spacing(1),
  },
}))

function WorkflowInput({ input, meta, workflowsConfig }) {
  const classes = useWorkflowInputStyles()

  const disabled = meta.submitting || meta.submitSucceeded

  return (
    <div className={classes.root}>
      <SelectWorkflow
        className={classes.select}
        items={workflowsConfig ? workflowsConfig.workflows : []}
        onChange={input.onChange}
        value={input.value}
        disabled={disabled}
      />
    </div>
  )
}

function SchemaFetcher({ children, schemaUrl }) {
  const s3 = AWS.S3.use()
  const data = useData(requests.metadataSchema, { s3, schemaUrl })
  const res = React.useMemo(
    () =>
      data.case({
        Ok: (schema) => AsyncResult.Ok({ schema, validate: validateMeta(schema) }),
        Err: (responseError) =>
          AsyncResult.Ok({ responseError, validate: validateMeta(null) }),
        _: R.identity,
      }),
    [data],
  )
  return children(res)
}

const getWorkflowApiParam = R.cond([
  [R.equals(requests.workflowNotAvaliable), R.always(undefined)],
  [R.equals(requests.workflowNotSelected), R.always(null)],
  [R.T, R.identity],
])

function PackageCreateDialog({ bucket, open, workflowsConfig, onClose, refresh }) {
  const s3 = AWS.S3.use()
  const req = APIConnector.use()
  const { urls } = NamedRoutes.use()
  const [uploads, setUploads] = React.useState({})
  const [success, setSuccess] = React.useState(null)
  const validateCacheKey = useCounter()

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const validateName = React.useCallback(
    cacheDebounce(async (name) => {
      if (name) {
        const res = await req({
          endpoint: '/package_name_valid',
          method: 'POST',
          body: { name },
        })
        if (!res.valid) return 'invalid'
      }
      return undefined
    }, 200),
    [req, validateCacheKey.value],
  )

  const reset = (form) => () => {
    form.restart()
    setSuccess(null)
    setUploads({})
    validateCacheKey.inc()
  }

  const handleClose = ({ submitting = false } = {}) => () => {
    if (submitting) return
    // TODO: ask to abort if in progress
    onClose()
  }

  const totalProgress = getTotalProgress(uploads)

  // eslint-disable-next-line consistent-return
  const uploadPackage = async ({ name, msg, files, meta, workflow }) => {
    const limit = pLimit(2)
    let rejected = false
    const uploadStates = files.map(({ path, file }) => {
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
      return Errors.FILES_UPLOAD
    }

    const contents = R.zipWith(
      (f, u) => ({
        logical_key: f.path,
        physical_key: s3paths.handleToS3Url({
          bucket,
          key: u.result.Key,
          version: u.result.VersionId,
        }),
        size: f.file.size,
        hash: u.hash,
      }),
      files,
      uploaded,
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
          meta: getMetaValue(meta),
          workflow: getWorkflowApiParam(workflow.slug),
        },
      })
      if (refresh) {
        // wait for ES index to receive the new package data
        await new Promise((resolve) => setTimeout(resolve, ES_LAG))
        refresh()
      }
      setSuccess({ name, revision: res.timestamp })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('error creating manifest', e)
      if (e.message) {
        return {
          [FORM_ERROR]: e.message,
        }
      }
      // TODO: handle specific cases?
      return Errors.PACKAGE_CREATION
    }
  }

  return (
    <RF.Form onSubmit={uploadPackage}>
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
        <M.Dialog
          open={open}
          onClose={handleClose({ submitting })}
          fullWidth
          scroll="body"
          onExited={reset(form)}
        >
          <M.DialogTitle>{success ? 'Push complete' : 'Push package'}</M.DialogTitle>
          {success ? (
            <>
              <M.DialogContent style={{ paddingTop: 0 }}>
                <M.Typography>
                  Package{' '}
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
                <M.Button
                  component={Link}
                  to={urls.bucketPackageTree(bucket, success.name, success.revision)}
                  variant="contained"
                  color="primary"
                >
                  Browse package
                </M.Button>
              </M.DialogActions>
            </>
          ) : (
            <>
              <M.DialogContent style={{ paddingTop: 0 }}>
                <form onSubmit={handleSubmit}>
                  <RF.Field
                    component={Field}
                    name="name"
                    label="Name"
                    placeholder="Enter a package name"
                    validate={validators.composeAsync(validators.required, validateName)}
                    validateFields={['name']}
                    errors={{
                      required: 'Enter a package name',
                      invalid: 'Invalid package name',
                    }}
                    margin="normal"
                    fullWidth
                  />

                  <RF.Field
                    component={Field}
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
                  />

                  <SchemaFetcher
                    schemaUrl={R.pathOr('', ['schema', 'url'], values.workflow)}
                  >
                    {AsyncResult.case({
                      Ok: ({ responseError, schema, validate }) => (
                        <RF.Field
                          component={MetaInput}
                          bucket={bucket}
                          name="meta"
                          schema={schema}
                          schemaError={responseError}
                          validate={validate}
                          validateFields={['meta']}
                          isEqual={R.equals}
                        />
                      ),
                      _: () => <MetaInputSkeleton />,
                    })}
                  </SchemaFetcher>

                  <RF.Field
                    component={WorkflowInput}
                    workflowsConfig={workflowsConfig}
                    initialValue={
                      workflowsConfig
                        ? workflowsConfig.workflows.find((item) => item.isDefault)
                        : null
                    }
                    name="workflow"
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

export default function PackageCreateDialogWrapper({ bucket, open, onClose, refresh }) {
  const s3 = AWS.S3.use()
  const data = useData(requests.workflowsList, { s3, bucket })

  return data.case({
    Ok: (workflowsConfig) => (
      <PackageCreateDialog
        {...{
          bucket,
          open,
          onClose,
          refresh,
          workflowsConfig,
        }}
      />
    ),
    Err: (error) => {
      // eslint-disable-next-line no-console
      console.error(error)
      return null
    },
    // TODO: show some progress indicator, e.g. skeleton or spinner
    _: () => null,
  })
}
