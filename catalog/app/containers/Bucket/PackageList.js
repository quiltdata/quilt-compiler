import * as dateFns from 'date-fns'
import * as R from 'ramda'
import * as React from 'react'
import { FormattedRelative, FormattedPlural } from 'react-intl'
import { useHistory, Link } from 'react-router-dom'
import * as M from '@material-ui/core'
import { fade } from '@material-ui/core/styles'

import Skeleton from 'components/Skeleton'
import Sparkline from 'components/Sparkline'
import * as AWS from 'utils/AWS'
// import AsyncResult from 'utils/AsyncResult'
// import * as BucketConfig from 'utils/BucketConfig'
import * as Config from 'utils/Config'
import * as Data from 'utils/Data'
// import * as LinkedData from 'utils/LinkedData'
import * as NamedRoutes from 'utils/NamedRoutes'
import StyledLink from 'utils/StyledLink'
import * as SVG from 'utils/SVG'
import parseSearch from 'utils/parseSearch'
import { readableQuantity } from 'utils/string'
import useDebouncedInput from 'utils/useDebouncedInput'
import usePrevious from 'utils/usePrevious'

import PackageCreateDialog from './PackageCreateDialog'
import Pagination from './Pagination'
import { displayError } from './errors'
import * as requests from './requests'

const EXAMPLE_PACKAGE_URL = 'https://docs.quiltdata.com/walkthrough/editing-a-package'

const PER_PAGE = 30

const SORT_OPTIONS = [
  { key: 'name', label: 'Name' },
  { key: 'modified', label: 'Updated' },
]

const DEFAULT_SORT = SORT_OPTIONS[0]

const getSort = (key) => (key && SORT_OPTIONS.find((o) => o.key === key)) || DEFAULT_SORT

function Counts({ counts, total }) {
  const [cursor, setCursor] = React.useState(null)
  const t = M.useTheme()
  const xs = M.useMediaQuery(t.breakpoints.down('xs'))
  const sm = M.useMediaQuery(t.breakpoints.down('sm'))
  // eslint-disable-next-line no-nested-ternary
  const sparklineW = xs ? 176 : sm ? 300 : 400
  const sparklineH = xs ? 32 : 40
  return (
    <M.Box position="absolute" right={0} top={0} bottom={0}>
      <M.Box position="absolute" right={16} top={16} whiteSpace="nowrap">
        <M.Typography
          variant="body2"
          color={cursor === null ? 'textSecondary' : 'textPrimary'}
          component="span"
          noWrap
        >
          {cursor === null
            ? 'Total views'
            : dateFns.format(counts[cursor].date, `MMM do`)}
          :
        </M.Typography>
        <M.Box
          component="span"
          textAlign="right"
          ml={1}
          minWidth={30}
          display="inline-block"
        >
          <M.Typography
            variant="subtitle2"
            color={cursor === null ? 'textSecondary' : 'textPrimary'}
            component="span"
          >
            {readableQuantity(cursor === null ? total : counts[cursor].value)}
          </M.Typography>
        </M.Box>
      </M.Box>
      <Sparkline
        boxProps={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: sparklineW,
          height: sparklineH,
        }}
        data={R.pluck('value', counts)}
        onCursor={setCursor}
        width={sparklineW}
        height={sparklineH}
        pb={8}
        pt={5}
        px={10}
        extendL
        extendR
        stroke={SVG.Paint.Color(M.colors.blue[500])}
        fill={SVG.Paint.Server(
          <linearGradient>
            <stop offset="0" stopColor={fade(M.colors.blue[500], 0)} />
            <stop offset="30%" stopColor={fade(M.colors.blue[500], 0.3)} />
          </linearGradient>,
        )}
        contourThickness={1.5}
        cursorLineExtendUp={false}
        cursorCircleR={3}
        cursorCircleFill={SVG.Paint.Color(M.colors.common.white)}
      />
    </M.Box>
  )
}

const usePackageStyles = M.makeStyles((t) => ({
  root: {
    position: 'relative',

    [t.breakpoints.down('xs')]: {
      borderRadius: 0,
    },

    [t.breakpoints.up('sm')]: {
      marginTop: t.spacing(1),
    },
  },
  handleContainer: {
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    display: '-webkit-box',
    overflow: 'hidden',
    overflowWrap: 'break-word',
    paddingLeft: t.spacing(2),
    paddingRight: t.spacing(21),
    paddingTop: t.spacing(2),
    textOverflow: 'ellipsis',
  },
  handle: {
    fontSize: t.typography.pxToRem(16),
    fontWeight: t.typography.fontWeightMedium,
    lineHeight: t.typography.pxToRem(20),
  },
  handleText: {
    position: 'relative',
  },
  handleClickArea: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,

    '$handle:hover &': {
      background: t.palette.action.hover,
    },
  },
  revisions: {
    ...t.typography.subtitle2,
    color: t.palette.text.secondary,
    position: 'relative',
  },
  updated: {
    ...t.typography.body2,
    color: t.palette.text.secondary,
    position: 'relative',
  },
}))

function Package({ name, modified, revisions, bucket, views }) {
  const { urls } = NamedRoutes.use()
  const classes = usePackageStyles()
  const t = M.useTheme()
  const xs = M.useMediaQuery(t.breakpoints.down('xs'))
  return (
    <M.Paper className={classes.root}>
      <div className={classes.handleContainer}>
        <Link className={classes.handle} to={urls.bucketPackageDetail(bucket, name)}>
          <span className={classes.handleClickArea} />
          <span className={classes.handleText}>{name}</span>
        </Link>
      </div>
      <M.Box pl={2} pb={2} pt={1}>
        <span className={classes.revisions}>
          {revisions}{' '}
          {xs ? (
            'Rev.'
          ) : (
            <FormattedPlural one="Revision" other="Revisions" value={revisions} />
          )}
        </span>
        <M.Box mr={2} component="span" />
        <span className={classes.updated}>
          {xs ? 'Upd. ' : 'Updated '}
          {modified ? <FormattedRelative value={modified} /> : '[unknown: see console]'}
        </span>
      </M.Box>
      {!!views && <Counts {...views} />}
    </M.Paper>
  )
}

function PackageSkel() {
  const classes = usePackageStyles()
  return (
    <M.Paper className={classes.root}>
      <M.Box p={2}>
        <Skeleton height={20} width="50%" borderRadius="borderRadius" />
        <Skeleton mt={1} height={20} width="70%" borderRadius="borderRadius" />
      </M.Box>
    </M.Paper>
  )
}

const useSortDropdownStyles = M.makeStyles((t) => ({
  root: {
    paddingBottom: t.spacing(1),
    paddingLeft: t.spacing(1.5),
    paddingTop: t.spacing(1),
    textTransform: 'none',
    ...t.typography.body1,
  },
}))

function SortDropdown({ value, options, makeSortUrl }) {
  const t = M.useTheme()
  const xs = M.useMediaQuery(t.breakpoints.down('xs'))
  const classes = useSortDropdownStyles()
  const [anchor, setAnchor] = React.useState(null)
  const open = React.useCallback(
    (evt) => {
      setAnchor(evt.target)
    },
    [setAnchor],
  )
  const close = React.useCallback(() => {
    setAnchor(null)
  }, [setAnchor])

  const selected = getSort(value)

  return (
    <>
      {xs ? (
        <M.IconButton onClick={open}>
          <M.Icon>sort</M.Icon>
        </M.IconButton>
      ) : (
        <M.Button onClick={open} className={classes.root}>
          Sort by:
          <M.Box component="span" fontWeight="fontWeightMedium" ml={1}>
            {selected.label}
          </M.Box>
          <M.Icon>expand_more</M.Icon>
        </M.Button>
      )}
      <M.Menu anchorEl={anchor} open={!!anchor} onClose={close}>
        {options.map((o) => (
          <M.MenuItem
            onClick={close}
            component={Link}
            to={makeSortUrl(o.key)}
            key={o.key}
            selected={o.key === value}
          >
            {o.label}
          </M.MenuItem>
        ))}
      </M.Menu>
    </>
  )
}

const useStyles = M.makeStyles((t) => ({
  paper: {
    [t.breakpoints.down('xs')]: {
      borderRadius: 0,
      boxShadow: 'none',
    },
  },
  searchIcon: {
    left: 8,
    pointerEvents: 'none',
    position: 'absolute',
  },
  input: {
    paddingLeft: t.spacing(5),
    paddingRight: t.spacing(5),
    paddingBottom: 11,
    paddingTop: 10,
    [t.breakpoints.down('xs')]: {
      paddingBottom: 15,
      paddingTop: 14,
    },
  },
  clear: {
    position: 'absolute',
    right: -4,
  },
}))

export default function PackageList({
  match: {
    params: { bucket },
  },
  location,
}) {
  const history = useHistory()
  const s3 = AWS.S3.use()
  const req = AWS.APIGateway.use()
  // const sign = AWS.Signer.useS3Signer()
  // const { analyticsBucket, apiGatewayEndpoint: endpoint } = Config.useConfig()
  const { analyticsBucket } = Config.useConfig()
  const { urls } = NamedRoutes.use()
  // const bucketCfg = BucketConfig.useCurrentBucketConfig()
  const classes = useStyles()

  const scrollRef = React.useRef(null)

  const { sort, filter, p } = parseSearch(location.search)
  const page = p && parseInt(p, 10)
  const computedPage = page || 1
  const computedSort = getSort(sort)
  const computedFilter = filter || ''
  const filtering = useDebouncedInput(computedFilter, 500)
  const today = React.useMemo(() => new Date(), [])

  const [counter, setCounter] = React.useState(0)
  const refresh = React.useCallback(() => setCounter(R.inc), [setCounter])

  const [uploadOpen, setUploadOpen] = React.useState(false)

  const openUpload = React.useCallback(() => {
    setUploadOpen(true)
  }, [setUploadOpen])

  const closeUpload = React.useCallback(() => {
    setUploadOpen(false)
  }, [setUploadOpen])

  const totalCountData = Data.use(requests.countPackages, { req, bucket, counter })
  const filteredCountData = Data.use(requests.countPackages, {
    req,
    bucket,
    filter: computedFilter,
    counter,
  })
  const packagesData = Data.use(requests.listPackages, {
    s3,
    req,
    analyticsBucket,
    bucket,
    filter,
    sort,
    perPage: PER_PAGE,
    page,
    today,
    counter,
  })

  const makeSortUrl = React.useCallback(
    (s) =>
      urls.bucketPackageList(bucket, {
        filter,
        sort: s === DEFAULT_SORT.key ? undefined : s,
        // reset page if sort order changed
        p: s === computedSort.key ? page : undefined,
      }),
    [urls, bucket, filter, computedSort, page],
  )

  const makePageUrl = React.useCallback(
    (newP) =>
      urls.bucketPackageList(bucket, { filter, sort, p: newP !== 1 ? newP : undefined }),
    [urls, bucket, filter, sort],
  )

  // set filter query param on filter input change (debounced)
  React.useEffect(() => {
    if (filtering.value !== computedFilter) {
      history.push(
        urls.bucketPackageList(bucket, { filter: filtering.value || undefined, sort }),
      )
    }
  }, [history, urls, bucket, sort, filtering.value, computedFilter])

  // scroll to top on page change
  usePrevious(computedPage, (prev) => {
    if (prev && computedPage !== prev && scrollRef.current) {
      scrollRef.current.scrollIntoView()
    }
  })

  return (
    <>
      <PackageCreateDialog
        {...{ bucket, refresh, open: uploadOpen, onClose: closeUpload }}
      />
      {totalCountData.case({
        _: () => (
          <M.Box pb={{ xs: 0, sm: 5 }} mx={{ xs: -2, sm: 0 }}>
            <M.Box mt={{ xs: 0, sm: 3 }} display="flex" justifyContent="space-between">
              <M.Box
                component={M.Paper}
                className={classes.paper}
                flexGrow={{ xs: 1, sm: 0 }}
                px={2}
                py={{ xs: 1.75, sm: 1.25 }}
              >
                <Skeleton
                  height={20}
                  width={{ xs: '100%', sm: 160 }}
                  borderRadius="borderRadius"
                />
              </M.Box>
              <M.Box
                component={M.Paper}
                className={classes.paper}
                px={2}
                py={{ xs: 1.75, sm: 1.25 }}
              >
                <Skeleton
                  height={20}
                  width={{ xs: 24, sm: 120 }}
                  borderRadius="borderRadius"
                />
              </M.Box>
            </M.Box>
            {R.range(0, 10).map((i) => (
              <PackageSkel key={i} />
            ))}
          </M.Box>
        ),
        Err: displayError(),
        Ok: (totalCount) => {
          if (!totalCount) {
            return (
              <M.Box pt={5} textAlign="center">
                <M.Typography variant="h4">No packages</M.Typography>
                <M.Box pt={3} />
                <M.Button
                  variant="contained"
                  color="primary"
                  onClick={openUpload}
                  startIcon={<M.Icon>add</M.Icon>}
                >
                  Push package
                </M.Button>
                <M.Box pt={2} />
                <M.Typography>
                  Or{' '}
                  <StyledLink href={EXAMPLE_PACKAGE_URL} target="_blank">
                    push a package
                  </StyledLink>{' '}
                  with the Quilt Python API.
                </M.Typography>
              </M.Box>
            )
          }

          return (
            <M.Box pb={{ xs: 0, sm: 5 }} mx={{ xs: -2, sm: 0 }}>
              <M.Box position="relative" top={-80} ref={scrollRef} />
              <M.Box display="flex" mt={{ xs: 0, sm: 3 }}>
                <M.Box
                  component={M.Paper}
                  className={classes.paper}
                  flexGrow={{ xs: 1, sm: 0 }}
                  position="relative"
                >
                  <M.InputBase
                    {...filtering.input}
                    placeholder="Filter packages"
                    classes={{ input: classes.input }}
                    fullWidth
                    startAdornment={
                      <M.Icon className={classes.searchIcon}>search</M.Icon>
                    }
                    endAdornment={
                      <M.Fade in={!!filtering.input.value}>
                        <M.IconButton
                          className={classes.clear}
                          onClick={() => filtering.set('')}
                        >
                          <M.Icon>clear</M.Icon>
                        </M.IconButton>
                      </M.Fade>
                    }
                  />
                </M.Box>
                <M.Box flexGrow={1} display={{ xs: 'none', sm: 'block' }} />
                <M.Box display={{ xs: 'none', sm: 'block' }} pr={1}>
                  <M.Button
                    variant="contained"
                    size="large"
                    color="primary"
                    style={{ paddingTop: 7, paddingBottom: 7 }}
                    onClick={openUpload}
                    startIcon={<M.Icon>add</M.Icon>}
                  >
                    Push package
                  </M.Button>
                </M.Box>
                <M.Box component={M.Paper} className={classes.paper}>
                  <SortDropdown
                    value={computedSort.key}
                    options={SORT_OPTIONS}
                    makeSortUrl={makeSortUrl}
                  />
                </M.Box>
              </M.Box>

              {filteredCountData.case({
                _: () => R.range(0, 10).map((i) => <PackageSkel key={i} />),
                Err: displayError(),
                Ok: (filteredCount) => {
                  if (!filteredCount) {
                    return (
                      <M.Box
                        borderTop={{ xs: 1, sm: 0 }}
                        borderColor="divider"
                        pt={3}
                        px={{ xs: 2, sm: 0 }}
                      >
                        <M.Typography variant="h5">
                          No matching packages found
                        </M.Typography>
                      </M.Box>
                    )
                  }

                  const pages = Math.ceil(filteredCount / PER_PAGE)

                  return (
                    <>
                      {packagesData.case({
                        _: () => {
                          const items =
                            computedPage < pages ? PER_PAGE : filteredCount % PER_PAGE
                          return R.range(0, items).map((i) => <PackageSkel key={i} />)
                        },
                        Err: displayError(),
                        Ok: R.map((pkg) => (
                          <Package key={pkg.name} {...pkg} bucket={bucket} />
                        )),
                      })}
                      {pages > 1 && (
                        <Pagination {...{ pages, page: computedPage, makePageUrl }} />
                      )}
                    </>
                  )
                },
              })}
            </M.Box>
          )
        },
      })}
    </>
  )
}

/* TODO: optimize LinkedData fetching
{!!bucketCfg &&
  (packages && []).map(({ name }) => (
    <Data.Fetcher
      key={name}
      fetch={requests.getRevisionData}
      params={{ s3, sign, endpoint, bucket, name, id: 'latest', maxKeys: 0 }}
    >
      {AsyncResult.case({
        _: () => null,
        Ok: ({ hash, modified, header }) => (
          <React.Suspense fallback={null}>
            <LinkedData.PackageData
              {...{
                bucket: bucketCfg,
                name,
                revision: 'latest',
                hash,
                modified,
                header,
              }}
            />
          </React.Suspense>
        ),
      })}
    </Data.Fetcher>
  ))}
*/
