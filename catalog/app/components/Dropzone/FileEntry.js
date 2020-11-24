import cx from 'classnames'
import * as React from 'react'
import * as M from '@material-ui/core'

import { readableBytes } from 'utils/string'

const useStyles = M.makeStyles((t) => ({
  root: {
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
}))

export default function FileEntry({ className, iconName, path, size, title, onClick }) {
  const classes = useStyles()

  return (
    <div className={cx(classes.root, className)}>
      <M.IconButton onClick={onClick} size="small" title={title}>
        <M.Icon fontSize="inherit">{iconName}</M.Icon>
      </M.IconButton>
      <div className={classes.filePath} title={path}>
        {path}
      </div>
      <div className={classes.fileSize}>{readableBytes(size)}</div>
    </div>
  )
}
