import cx from 'classnames'
import { FORM_ERROR } from 'final-form'
import pLimit from 'p-limit'
import * as R from 'ramda'
import * as React from 'react'
import { useDropzone } from 'react-dropzone'
import * as RF from 'react-final-form'
import { Link } from 'react-router-dom'
import * as M from '@material-ui/core'

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

import * as PD from './PackageDialog'
import * as requests from './requests'

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

  const warn = totalSize > PD.MAX_SIZE

  // eslint-disable-next-line no-nested-ternary
  const label = error ? (
    errors[error] || error
  ) : warn ? (
    <>Total file size exceeds recommended maximum of {readableBytes(PD.MAX_SIZE)}</>
  ) : (
    'Drop files here or click to browse'
  )

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const onDrop = React.useCallback(
    disabled
      ? () => {}
      : R.pipe(
          R.reduce((entries, file) => {
            const path = PD.getNormalizedPath(file)
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

function PackageCreateDialog({ bucket, open, workflowsConfig, onClose, refresh }) {
  const s3 = AWS.S3.use()
  const req = APIConnector.use()
  const { urls } = NamedRoutes.use()
  const [uploads, setUploads] = React.useState({})
  const [success, setSuccess] = React.useState(null)
  const nameValidator = PD.useNameValidator()

  const reset = (form) => () => {
    form.restart()
    setSuccess(null)
    setUploads({})
    nameValidator.inc()
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
      return { [FORM_ERROR]: PD.ERROR_MESSAGES.UPLOAD }
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
          meta: PD.getMetaValue(meta),
          workflow: PD.getWorkflowApiParam(workflow.slug),
        },
      })
      if (refresh) {
        // wait for ES index to receive the new package data
        await new Promise((resolve) => setTimeout(resolve, PD.ES_LAG))
        refresh()
      }
      setSuccess({ name, revision: res.timestamp })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('error creating manifest', e)
      // TODO: handle specific cases?
      return { [FORM_ERROR]: e.message || PD.ERROR_MESSAGES.MANIFEST }
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
                          validateFields={['meta']}
                          isEqual={R.equals}
                        />
                      ),
                      _: () => <PD.MetaInputSkeleton />,
                    })}
                  </PD.SchemaFetcher>

                  <RF.Field
                    component={PD.WorkflowInput}
                    name="workflow"
                    workflowsConfig={workflowsConfig}
                    initialValue={PD.defaultWorkflowFromConfig(workflowsConfig)}
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

  const data = useData(requests.workflowsList, { s3, bucket }, { noAutoFetch: !open })

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
    Err: (error) => (
      <M.Dialog open={open} onClose={onClose} fullWidth scroll="body">
        <PD.DialogError error={error} title="Push package" onCancel={onClose} />
      </M.Dialog>
    ),
    _: () => (
      <M.Dialog open={open} onClose={onClose} fullWidth scroll="body">
        <PD.DialogLoading title="Push package" onCancel={onClose} />
      </M.Dialog>
    ),
  })
}
