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
    display: 'flex',
    flexDirection: 'column',
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
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
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
    flexGrow: 1,
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
    cursor: 'pointer',
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
    maxHeight: t.spacing(40),
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
  className,
  meta,
  uploads,
  setUploads,
  errors = {},
}) {
  const classes = useFilesInputStyles()

  const value = React.useMemo(() => inputValue || [], [inputValue])
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
    <div className={cx(classes.root, className)}>
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
            <span>{label}</span>
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

const useStyles = M.makeStyles((t) => ({
  files: {
    display: 'flex',
    flexDirection: 'column',
    marginTop: t.spacing(3),
  },
}))

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

const defaultNameWarning = ' ' // Reserve space for warning

function PackageCreateDialog({
  bucket,
  open,
  initError,
  loading,
  workflowsConfig,
  onClose,
  refresh,
}) {
  const s3 = AWS.S3.use()
  const req = APIConnector.use()
  const { urls } = NamedRoutes.use()
  const [uploads, setUploads] = React.useState({})
  const [success, setSuccess] = React.useState(null)
  const nameValidator = PD.useNameValidator()
  const nameExistence = PD.useNameExistence(bucket)
  const [nameWarning, setNameWarning] = React.useState(defaultNameWarning)
  const classes = useStyles()

  const reset = (form) => () => {
    form.restart()
    setSuccess(null)
    setUploads({})
    nameValidator.inc()
    nameExistence.inc()
    setNameWarning(defaultNameWarning)
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
      setSuccess({ name, hash: res.top_hash })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('error creating manifest', e)
      // TODO: handle specific cases?
      return { [FORM_ERROR]: e.message || PD.ERROR_MESSAGES.MANIFEST }
    }
  }

  const onFormChange = React.useCallback(
    async ({ modified, values }) => {
      if (!modified.name) return

      const { name } = values

      let warning = defaultNameWarning

      const nameExists = await nameExistence.validate(name)
      if (nameExists) {
        warning = `Package "${name}" exists. Submitting will revise it`
      }

      if (warning !== nameWarning) {
        setNameWarning(warning)
      }
    },
    [nameWarning, nameExistence],
  )

  const initialWorkflow = React.useMemo(
    () => PD.defaultWorkflowFromConfig(workflowsConfig),
    [workflowsConfig],
  )

  const [workflow, setWorkflow] = React.useState(initialWorkflow)

  return (
    <RF.Form
      onSubmit={uploadPackage}
      subscription={{
        handleSubmit: true,
        submitting: true,
        submitFailed: true,
        error: true,
        submitError: true,
        hasValidationErrors: true,
        form: true,
      }}
    >
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
          fullWidth
          maxWidth={success ? 'sm' : 'lg'}
          onClose={handleClose({ submitting })}
          onExited={reset(form)}
          open={open}
          scroll="body"
        >
          {initError || loading || success ? (
            <>
              {initError && (
                <PD.DialogError
                  error={initError}
                  skeletonElement={<PD.FormSkeleton animate={false} />}
                  title="Create package"
                  onCancel={handleClose({ submitting })}
                />
              )}

              {loading && (
                <PD.DialogLoading
                  skeletonElement={<PD.FormSkeleton />}
                  title="Create package"
                  onCancel={handleClose({ submitting })}
                />
              )}

              {success && (
                <>
                  <M.DialogTitle>Package created</M.DialogTitle>
                  <M.DialogContent style={{ paddingTop: 0 }}>
                    <M.Typography>
                      Package{' '}
                      <StyledLink
                        to={urls.bucketPackageTree(bucket, success.name, success.hash)}
                      >
                        {success.name}@{R.take(10, success.hash)}
                      </StyledLink>{' '}
                      successfully created
                    </M.Typography>
                  </M.DialogContent>
                  <M.DialogActions>
                    <M.Button onClick={handleClose()}>Close</M.Button>
                    <M.Button
                      component={Link}
                      to={urls.bucketPackageTree(bucket, success.name, success.hash)}
                      variant="contained"
                      color="primary"
                    >
                      Browse package
                    </M.Button>
                  </M.DialogActions>
                </>
              )}
            </>
          ) : (
            <>
              <M.DialogTitle>Create package</M.DialogTitle>
              <M.DialogContent style={{ paddingTop: 0 }}>
                <form onSubmit={handleSubmit}>
                  <RF.FormSpy
                    subscription={{ modified: true, values: true }}
                    onChange={onFormChange}
                  />

                  <RF.FormSpy
                    subscription={{ modified: true, values: true }}
                    onChange={({ modified, values }) => {
                      if (modified.workflow) {
                        setWorkflow(values.workflow)
                      }
                    }}
                  />

                  <PD.Container>
                    <PD.LeftColumn>
                      <M.Typography color={submitting ? 'textSecondary' : undefined}>
                        Main
                      </M.Typography>

                      <RF.Field
                        component={PD.PackageNameInput}
                        name="name"
                        validate={validators.composeAsync(
                          validators.required,
                          nameValidator.validate,
                        )}
                        validateFields={['name']}
                        errors={{
                          required: 'Enter a package name',
                          invalid: 'Invalid package name',
                        }}
                        helperText={nameWarning}
                        validating={nameValidator.processing}
                      />

                      <RF.Field
                        component={PD.CommitMessageInput}
                        name="msg"
                        validate={validators.required}
                        validateFields={['msg']}
                        errors={{
                          required: 'Enter a commit message',
                        }}
                      />

                      <RF.Field
                        className={classes.files}
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

                      <RF.Field
                        component={PD.WorkflowInput}
                        name="workflow"
                        workflowsConfig={workflowsConfig}
                        initialValue={initialWorkflow}
                        validate={validators.required}
                        validateFields={['meta', 'workflow']}
                        errors={{
                          required: 'Workflow is required for this bucket.',
                        }}
                      />
                    </PD.LeftColumn>

                    <PD.RightColumn>
                      <PD.SchemaFetcher
                        schemaUrl={R.pathOr('', ['schema', 'url'], workflow)}
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
                              initialValue={PD.EMPTY_META_VALUE}
                            />
                          ),
                          _: () => <PD.MetaInputSkeleton className={classes.meta} />,
                        })}
                      </PD.SchemaFetcher>
                    </PD.RightColumn>
                  </PD.Container>

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
                  Create
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
  const props = {
    bucket,
    open,
    onClose,
    refresh,
    workflowsConfig: null,
  }
  return data.case({
    Ok: (workflowsConfig) => (
      <PackageCreateDialog {...props} workflowsConfig={workflowsConfig} />
    ),
    Err: (error) => <PackageCreateDialog {...props} initError={error} />,
    _: () => <PackageCreateDialog {...props} loading />,
  })
}
