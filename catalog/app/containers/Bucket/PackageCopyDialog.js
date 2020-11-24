import cx from 'classnames'
import * as R from 'ramda'
import { FORM_ERROR } from 'final-form'
import * as React from 'react'
import * as RF from 'react-final-form'
import * as M from '@material-ui/core'
import { fade } from '@material-ui/core/styles'

import AsyncResult from 'utils/AsyncResult'
import * as AWS from 'utils/AWS'
import * as Data from 'utils/Data'
import Delay from 'utils/Delay'
import * as Dropzone from 'components/Dropzone'
import FileEntry from 'components/Dropzone/FileEntry'
import DropMessage from 'components/Dropzone/DropMessage'
import { getBasename } from 'utils/s3paths'
import { readableBytes } from 'utils/string'
import tagged from 'utils/tagged'
import * as validators from 'utils/validators'

import * as ERRORS from './errors'
import * as PD from './PackageDialog'
import * as requests from './requests'

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

const useFilesInputStyles = M.makeStyles((t) => ({
  root: {
    marginTop: t.spacing(3),
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
}))

export function FilesInput({ input: { value: inputValue }, meta }) {
  const classes = useFilesInputStyles()

  const value = inputValue || []
  const error = meta.submitFailed && meta.error

  const totalSize = React.useMemo(() => value.reduce((sum, f) => sum + f.file.size, 0), [
    value,
  ])

  const warn = totalSize > PD.MAX_SIZE

  return (
    <div className={classes.root}>
      <Dropzone.Header disabled>
        {!!value.length && (
          <>
            : {value.length} ({readableBytes(totalSize)})
            {warn && <M.Icon style={{ marginLeft: 4 }}>error_outline</M.Icon>}
          </>
        )}
      </Dropzone.Header>

      <div className={classes.dropzoneContainer}>
        <div
          className={cx(
            classes.dropzone,
            !!error && classes.dropzoneErr,
            !error && warn && classes.dropzoneWarn,
          )}
        >
          {!!value.length && (
            <div
              className={cx(
                classes.filesContainer,
                !!error && classes.filesContainerErr,
                !error && warn && classes.filesContainerWarn,
              )}
            >
              {value.map(({ file }) => (
                <FileEntry
                  iconName="attach_file"
                  key={file.physicalKey}
                  path={getBasename(decodeURIComponent(file.physicalKey))}
                  size={file.size}
                />
              ))}
            </div>
          )}

          <DropMessage disabled />
        </div>

        <Dropzone.Overlay />
      </div>
    </div>
  )
}

function DialogForm({
  bucket,
  name: initialName,
  close,
  setSubmitting,
  onSuccess,
  manifest,
  workflowsConfig,
}) {
  const [uploads, setUploads] = React.useState({})

  const nameValidator = PD.useNameValidator()

  const initialMeta = React.useMemo(
    () => ({
      mode: 'kv',
      text: JSON.stringify(manifest.meta || {}),
    }),
    [manifest.meta],
  )

  const initialFiles = Object.values(manifest.entries).map((file) => ({
    file,
  }))

  const onSubmit = async ({ name }) => {
    onSuccess({ name })
    return { [FORM_ERROR]: 'Error creating manifest' }
  }

  const onSubmitWrapped = async (...args) => {
    setSubmitting(true)
    try {
      return await onSubmit(...args)
    } finally {
      setSubmitting(false)
    }
  }

  const totalProgress = React.useMemo(() => getTotalProgress(uploads), [uploads])

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
                      validateFields={['meta']}
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
          Unexpected error
        </M.Typography>
        <M.Typography gutterBottom>
          Something went wrong. Please contact Quilt support.
        </M.Typography>
        <M.Typography>You can also use Quilt CLI to edit this package.</M.Typography>
      </>
    ),
  ],
])

function DialogError({ error, close }) {
  const classes = useDialogErrorStyles()
  return (
    <>
      <M.DialogTitle>Copy package</M.DialogTitle>
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

function DialogSuccess() {
  return <h1>DialogSuccess</h1>
}

const DialogState = tagged([
  'Closed',
  'Loading',
  'Error',
  'Form', // { manifest, workflowsConfig }
  'Success', // { name, revision }
])

export function usePackageCopyDialog({ bucket, name, revision, onExited }) {
  const s3 = AWS.S3.use()

  const [isOpen, setOpen] = React.useState(false)
  const [wasOpened, setWasOpened] = React.useState(false)
  const [exited, setExited] = React.useState(!isOpen)
  const [exitValue, setExitValue] = React.useState(null)
  const [success, setSuccess] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [key, setKey] = React.useState(1)

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

  const manifestData = Data.use(
    requests.loadManifest,
    { s3, bucket, name, revision, key },
    { noAutoFetch: !wasOpened },
  )

  const workflowsData = Data.use(requests.workflowsList, { s3, bucket })

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
                close,
                name,
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

export const use = usePackageCopyDialog
