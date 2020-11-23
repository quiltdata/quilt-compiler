import * as R from 'ramda'
import * as React from 'react'
import * as RF from 'react-final-form'
import * as M from '@material-ui/core'
import { fade } from '@material-ui/core/styles'

import * as AWS from 'utils/AWS'
import { readableBytes } from 'utils/string'
import tagged from 'utils/tagged'

import * as PD from './PackageDialog'
import * as ERRORS from './errors'

function DialogWrapper({ exited, ...props }) {
  console.log('DialogWrapper')
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

function DialogForm() {
  return (
    <RF.Form>
      <h1>It works</h1>
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

function DialogSuccess({ bucket, name, revision, close }) {
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
    console.log('OPEN')
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
    return DialogState.Loading()
  }, [exited, success])

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
          Form: (props) => <DialogForm />,
          Success: (props) => <DialogSuccess {...{ bucket, close, ...props }} />,
        })}
      </DialogWrapper>
    ),
    [bucket, name, isOpen, exited, close, stateCase, handleExited],
  )

  return React.useMemo(() => ({ open, close, render }), [open, close, render])
}

export const use = usePackageCopyDialog
