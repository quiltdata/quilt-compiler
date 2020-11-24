import cx from 'classnames'
import * as React from 'react'
import * as M from '@material-ui/core'

import * as PD from 'containers/Bucket/PackageDialog'
import { readableBytes } from 'utils/string'

const useStyles = M.makeStyles((t) => ({
  root: {
    ...t.typography.body2,
    alignItems: 'center',
    display: 'flex',
    flexGrow: 1,
    justifyContent: 'center',
    paddingBottom: t.spacing(1),
    paddingTop: t.spacing(1),
    textAlign: 'center',
  },
  warning: {
    color: t.palette.warning.dark,
  },
  error: {
    color: t.palette.error.main,
  },
}))

export default function DropMessage({ error, warning }) {
  const classes = useStyles()

  const label = React.useMemo(() => {
    if (error) return error
    if (warning)
      return `Total file size exceeds recommended maximum of ${readableBytes(
        PD.MAX_SIZE,
      )}`
    return 'Drop files here or click to browse'
  }, [error, warning])

  return (
    <div
      className={cx(classes.root, {
        [classes.error]: !!error,
        [classes.warning]: !!warning,
      })}
    >
      {label}
    </div>
  )
}
