import * as R from 'ramda'
import * as React from 'react'
import * as M from '@material-ui/core'

import Skeleton from 'components/Skeleton'
import * as AWS from 'utils/AWS'
import AsyncResult from 'utils/AsyncResult'
import { useData } from 'utils/Data'

import * as requests from './requests'

const useStyles = M.makeStyles((t) => ({
  root: {
    flexShrink: 0,
    margin: `-3px 0`,
  },

  placeholder: {
    minWidth: t.spacing(30),
  },
}))

function MenuPlaceholder() {
  const t = M.useTheme()

  return (
    <M.Box minWidth={t.spacing(30)}>
      <M.MenuItem disabled>
        <Skeleton height={t.spacing(4)} width="100%" />
      </M.MenuItem>
      <M.MenuItem disabled>
        <Skeleton height={t.spacing(4)} width="100%" />
      </M.MenuItem>
      <M.MenuItem disabled>
        <Skeleton height={t.spacing(4)} width="100%" />
      </M.MenuItem>
    </M.Box>
  )
}

function MenuItem({ item, onClick }) {
  return (
    <M.MenuItem onClick={React.useCallback(() => onClick(item), [item, onClick])}>
      {item.name}
    </M.MenuItem>
  )
}

const BucketsListFetcher = React.forwardRef(({ bucket, children }, ref) => {
  const s3 = AWS.S3.use()
  const data = useData(requests.workflowsList, { s3, bucket })
  const res = data.case({
    Ok: AsyncResult.Ok,
    Err: AsyncResult.Err,
    _: R.identity,
  })
  return children({
    ref,
    ...res,
  })
})

export default function CopyButton({ bucket, onChange }) {
  const classes = useStyles()

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
    <>
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

      <M.Menu
        anchorEl={menuAnchorEl}
        className={classes.menu}
        onClose={onMenuClose}
        open={!!menuAnchorEl}
      >
        <BucketsListFetcher bucket={bucket}>
          {AsyncResult.case({
            Ok: ({ workflows }) => (
              <>
                {workflows.map((workflow) => (
                  <MenuItem key={workflow.slug} item={workflow} onClick={onMenuClick} />
                ))}
              </>
            ),
            _: () => <MenuPlaceholder />,
            Err: () => null,
          })}
        </BucketsListFetcher>
      </M.Menu>
    </>
  )
}
