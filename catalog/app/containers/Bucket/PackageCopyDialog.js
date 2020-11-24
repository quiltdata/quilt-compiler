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
import Dropzone, { Overlay as DropzoneOverlay } from 'components/Dropzone'
import { getBasename } from 'utils/s3paths'
import { readableBytes } from 'utils/string'
import tagged from 'utils/tagged'
import * as validators from 'utils/validators'

import * as ERRORS from './errors'
import * as PD from './PackageDialog'
import * as requests from './requests'

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
}))

export function FilesInput({ input: { value: inputValue }, meta }) {
  const classes = useFilesInputStyles()

  const value = inputValue || []
  const error = meta.submitFailed && meta.error

  const totalSize = React.useMemo(() => value.reduce((sum, f) => sum + f.file.size, 0), [
    value,
  ])

  const warn = totalSize > PD.MAX_SIZE

  const files = value.map(({ file }) => ({
    iconName: 'attach_file',
    key: file.physicalKey,
    path: getBasename(decodeURIComponent(file.physicalKey)),
    size: file.size,
  }))

  const statsComponent = !!files.length && (
    <>
      : {files.length} ({readableBytes(totalSize)})
      {warn && <M.Icon style={{ marginLeft: 4 }}>error_outline</M.Icon>}
    </>
  )

  return (
    <Dropzone
      className={classes.root}
      disabled
      error={error}
      files={files}
      overlayComponent={<DropzoneOverlay />}
      statsComponent={statsComponent}
      warning={warn}
      onDrop={R.always([])}
    />
  )
}

function DialogForm({
  bucket,
  name: initialName,
  close,
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

  const totalProgress = React.useMemo(() => getTotalProgress(uploads), [uploads])

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
        values,
      }) => (
        <>
          <M.DialogTitle>Copy package to &quot;{bucket}&quot; bucket</M.DialogTitle>
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

function DialogPlaceholder({ bucket, close }) {
  return (
    <>
      <M.DialogTitle>Copy package to &quot;{bucket}&quot; bucket</M.DialogTitle>
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

export default function PackageCopyDialog({
  sourceBucket,
  targetBucket,
  name,
  revision,
  onClose,
}) {
  const s3 = AWS.S3.use()

  const [success, setSuccess] = React.useState(false)

  const manifestData = Data.use(requests.loadManifest, {
    s3,
    bucket: sourceBucket,
    name,
    revision,
  })

  const workflowsData = Data.use(requests.workflowsList, { s3, bucket: targetBucket })

  const state = React.useMemo(() => {
    // if (exited) return DialogState.Closed()
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
  }, [success, workflowsData, manifestData])

  const stateCase = React.useCallback((cases) => DialogState.case(cases, state), [state])

  return (
    <M.Dialog open onClose={onClose} fullWidth scroll="body">
      {stateCase({
        Closed: () => null,
        Loading: () => <DialogPlaceholder bucket={targetBucket} close={onClose} />,
        Error: (e) => <DialogError close={onClose} error={e} />,
        Form: (props) => (
          <DialogForm
            {...{
              bucket: targetBucket,
              close: onClose,
              name,
              onSuccess: setSuccess,
              ...props,
            }}
          />
        ),
        Success: (props) => <DialogSuccess {...{ bucket: targetBucket, ...props }} />,
      })}
    </M.Dialog>
  )
}
