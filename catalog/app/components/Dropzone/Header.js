import cx from 'classnames'
import * as React from 'react'
import * as M from '@material-ui/core'

const useStyles = M.makeStyles((t) => ({
  root: {
    alignItems: 'center',
    display: 'flex',
    height: 24,
  },
  title: {
    ...t.typography.body1,
    display: 'flex',
  },
  disabled: {
    color: t.palette.text.secondary,
  },
  error: {
    color: t.palette.error.main,
  },
  warning: {
    color: t.palette.warning.dark,
  },
}))

export default function Header({ children, disabled, error, warning }) {
  const classes = useStyles()

  return (
    <div className={classes.root}>
      <div
        className={cx(classes.title, {
          [classes.disabled]: disabled,
          [classes.error]: error,
          [classes.warning]: warning,
        })}
      >
        Files
        {children}
      </div>
    </div>
  )
}
