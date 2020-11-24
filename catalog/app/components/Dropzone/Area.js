import cx from 'classnames'
import * as React from 'react'
import { useDropzone } from 'react-dropzone'
import * as M from '@material-ui/core'

import DropMessage from './DropMessage'
import FileEntry from './FileEntry'

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
  files: {
    borderBottom: `1px solid ${t.palette.action.disabled}`,
    maxHeight: 200,
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  filesError: {
    borderColor: t.palette.error.main,
  },
  filesWarning: {
    borderColor: t.palette.warning.dark,
  },
}))

export default function Area({
  className,
  disabled,
  error,
  files,
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

        {!!files.length && (
          <div
            className={cx(classes.files, {
              [classes.filesError]: !!error,
              [classes.filesWarning]: !!warning,
            })}
          >
            {files.map((file) => (
              <FileEntry
                iconName={file.iconName}
                key={file.key}
                path={file.path}
                size={file.size}
              />
            ))}
          </div>
        )}

        <DropMessage disabled={disabled} error={error} warning={warning} />
      </div>

      {overlay}
    </div>
  )
}
