import * as React from 'react'
import * as M from '@material-ui/core'

const useStyles = M.makeStyles(() => ({
  root: {
    flexShrink: 0,
    margin: `-3px 0`,
  },
}))

const MenuItem = React.forwardRef(({ item, onClick }) => (
  <M.MenuItem onClick={React.useCallback(() => onClick(item), [item, onClick])}>
    {item.title}
  </M.MenuItem>
))

export default function CopyButton({ onChange }) {
  const classes = useStyles()

  const items = [
    {
      title: 'one',
    },
    {
      title: 'two',
    },
  ]

  const [menuAnchorEl, setMenuAnchorEl] = React.useState(null)

  const onButtonClick = React.useCallback(
    (event) => setMenuAnchorEl(event.currentTarget),
    [setMenuAnchorEl],
  )

  const onMenuClick = React.useCallback(
    (menuItem) => {
      onChange(menuItem)
      setMenuAnchorEl(null)
    },
    [onChange, setMenuAnchorEl],
  )

  const onMenuClose = React.useCallback(() => setMenuAnchorEl(null), [setMenuAnchorEl])

  return (
    <div>
      <M.Button
        aria-haspopup="true"
        className={classes.root}
        color="primary"
        size="small"
        startIcon={<M.Icon>save_alt_outlined</M.Icon>}
        variant="outlined"
        onClick={onButtonClick}
      >
        Copy to bucket
      </M.Button>

      <M.Menu anchorEl={menuAnchorEl} onClose={onMenuClose} open={!!menuAnchorEl}>
        {items.map((item) => (
          <MenuItem item={item} onClick={onMenuClick} />
        ))}
      </M.Menu>
    </div>
  )
}
