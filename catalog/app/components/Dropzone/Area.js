import cx from 'classnames'
import * as React from 'react'
import { useDropzone } from 'react-dropzone'
import * as M from '@material-ui/core'

const useStyles = M.makeStyles((t) => ({
  root: {
    marginTop: t.spacing(2),
    position: 'relative',
  },
  container: {
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
  active: {
    background: t.palette.action.selected,
  },
  error: {
    borderColor: t.palette.error.main,
  },
  warning: {
    borderColor: t.palette.warning.dark,
  },
}))

export default function Area({
  children,
  className,
  disabled,
  error,
  overlay,
  warning,
  onDrop,
}) {
  const classes = useStyles()

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop })

  return (
    <div className={cx(classes.root, className)}>
      <div
        {...getRootProps({
          className: cx(classes.container, {
            [classes.active]: isDragActive && !disabled,
            [classes.error]: !!error,
            [classes.warning]: !!warning,
          }),
        })}
      >
        <input {...getInputProps()} />

        {children}
      </div>

      {overlay}
    </div>
  )
}
