import * as dateFns from 'date-fns'
import * as R from 'ramda'
import * as React from 'react'
import { FormattedPlural } from 'react-intl'
import { Link } from 'react-router-dom'
import * as M from '@material-ui/core'
import { fade } from '@material-ui/core/styles'

import JsonDisplay from 'components/JsonDisplay'
import Skeleton from 'components/Skeleton'
import Sparkline from 'components/Sparkline'
import AsyncResult from 'utils/AsyncResult'
import * as AWS from 'utils/AWS'
// import * as BucketConfig from 'utils/BucketConfig'
import * as Config from 'utils/Config'
import * as Data from 'utils/Data'
// import * as LinkedData from 'utils/LinkedData'
import * as NamedRoutes from 'utils/NamedRoutes'
import * as SVG from 'utils/SVG'
import copyToClipboard from 'utils/clipboard'
import parseSearch from 'utils/parseSearch'
import { readableBytes, readableQuantity } from 'utils/string'
import usePrevious from 'utils/usePrevious'

import Pagination from './Pagination'
import { useUpdateDialog } from './UpdateDialog'
import { displayError } from './errors'
import * as requests from './requests'

const PER_PAGE = 30

function SparklineSkel({ width, height }) {
  const [data] = React.useState(() => R.times((i) => i + Math.random() * i, 30))
  const t = M.useTheme()
  const c0 = fade(t.palette.action.hover, 0)
  const c1 = t.palette.action.hover
  const c2 = fade(t.palette.action.hover, t.palette.action.hoverOpacity * 0.4)
  return (
    <Sparkline
      boxProps={{
        position: 'absolute',
        right: 0,
        bottom: 0,
        width,
        height,
      }}
      data={data}
      width={width}
      height={height}
      pb={8}
      pt={5}
      px={10}
      extendL
      extendR
      stroke={SVG.Paint.Color(t.palette.action.hover)}
      fill={SVG.Paint.Server(
        <linearGradient>
          <stop offset="0" stopColor={c0} />
          <stop offset="30%" stopColor={c1}>
            <animate
              attributeName="stop-color"
              values={`${c1}; ${c2}; ${c1}`}
              dur="3s"
              repeatCount="indefinite"
            />
          </stop>
        </linearGradient>,
      )}
      contourThickness={1.5}
    />
  )
}

function Counts({ counts, total, sparklineW, sparklineH }) {
  const [cursor, setCursor] = React.useState(null)
  return (
    <>
      <M.Box position="absolute" right={16} top={0}>
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
    </>
  )
}

const useRevisionLayoutStyles = M.makeStyles((t) => ({
  root: {
    position: 'relative',

    [t.breakpoints.down('xs')]: {
      borderRadius: 0,
    },

    [t.breakpoints.up('sm')]: {
      marginTop: t.spacing(1),
    },
  },
}))

function RevisionLayout({ link, msg, meta, hash, stats, counts }) {
  const classes = useRevisionLayoutStyles()
  const t = M.useTheme()
  const xs = M.useMediaQuery(t.breakpoints.down('xs'))
  const sm = M.useMediaQuery(t.breakpoints.down('sm'))
  const sparklineW = xs ? 176 : sm ? 300 : 400
  const sparklineH = xs ? 32 : 48
  return (
    <M.Paper className={classes.root}>
      <M.Box pt={2} pl={2} pr={25}>
        {link}
      </M.Box>
      <M.Box py={1} pl={2} pr={xs ? 2 : Math.ceil(sparklineW / t.spacing(1) + 1)}>
        {msg}
      </M.Box>
      {!!meta && (
        <M.Hidden xsDown>
          <M.Divider />
          {meta}
        </M.Hidden>
      )}
      <M.Hidden xsDown>
        <M.Divider />
      </M.Hidden>
      <M.Box
        pl={2}
        pr={xs ? Math.ceil(sparklineW / t.spacing(1)) : 30}
        height={{ xs: 64, sm: 48 }}
        display="flex"
        alignItems="center"
      >
        {hash}
      </M.Box>
      <M.Box
        position="absolute"
        right={16}
        bottom={{ xs: 'auto', sm: 0 }}
        top={{ xs: 16, sm: 'auto' }}
        height={{ xs: 20, sm: 48 }}
        display="flex"
        alignItems="center"
        color="text.secondary"
      >
        {stats}
      </M.Box>
      <M.Box
        position="absolute"
        right={0}
        bottom={{ xs: 0, sm: 49 }}
        top={{ xs: 'auto', sm: 16 }}
        height={{ xs: 64, sm: 'auto' }}
        width={sparklineW}
      >
        {counts({ sparklineW, sparklineH })}
      </M.Box>
    </M.Paper>
  )
}

function RevisionSkel() {
  const t = M.useTheme()
  const xs = M.useMediaQuery(t.breakpoints.down('xs'))
  return (
    <RevisionLayout
      link={
        <M.Box height={20} display="flex" alignItems="center">
          <Skeleton borderRadius="borderRadius" height={16} width={200} />
        </M.Box>
      }
      msg={
        <>
          <M.Box height={20} display="flex" alignItems="center">
            <Skeleton borderRadius="borderRadius" height={16} width="100%" />
          </M.Box>
          {!xs && (
            <M.Box height={20} display="flex" alignItems="center">
              <Skeleton borderRadius="borderRadius" height={16} width="90%" />
            </M.Box>
          )}
        </>
      }
      hash={
        <Skeleton borderRadius="borderRadius" height={16} width="100%" maxWidth={550} />
      }
      stats={
        <M.Box display="flex" alignItems="center">
          <Skeleton borderRadius="borderRadius" width={70} height={16} mr={2} />
          <Skeleton borderRadius="borderRadius" width={70} height={16} />
        </M.Box>
      }
      counts={({ sparklineW, sparklineH }) => (
        <>
          <M.Box
            position="absolute"
            right={16}
            top={0}
            display="flex"
            alignItems="center"
            height={20}
            width={120}
          >
            <Skeleton height={16} width="100%" borderRadius="borderRadius" />
          </M.Box>
          <SparklineSkel width={sparklineW} height={sparklineH} />
        </>
      )}
    />
  )
}

const useRevisionStyles = M.makeStyles((t) => ({
  mono: {
    fontFamily: t.typography.monospace.fontFamily,
  },
  time: {
    ...t.typography.body1,
    fontWeight: t.typography.fontWeightMedium,
    lineHeight: t.typography.pxToRem(20),
    whiteSpace: 'nowrap',
  },
  msg: {
    ...t.mixins.lineClamp(2),
    overflowWrap: 'break-word',
    [t.breakpoints.up('sm')]: {
      minHeight: 40,
    },
  },
  hash: {
    color: t.palette.text.secondary,
    fontFamily: t.typography.monospace.fontFamily,
    fontSize: t.typography.body2.fontSize,
    maxWidth: 'calc(100% - 48px)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
}))

function Revision({
  bucket,
  name,
  hash,
  id,
  stats,
  message,
  modified,
  metadata,
  counts,
}) {
  const classes = useRevisionStyles()
  const { urls } = NamedRoutes.use()
  const t = M.useTheme()
  const xs = M.useMediaQuery(t.breakpoints.down('xs'))
  const dateFmt = xs ? 'MMM d yyyy - h:mmaaaaa' : 'MMMM do yyyy - h:mma'
  return (
    <RevisionLayout
      link={
        <Link className={classes.time} to={urls.bucketPackageTree(bucket, name, id)}>
          {dateFns.format(modified, dateFmt)}
        </Link>
      }
      msg={
        <M.Typography variant="body2" className={classes.msg}>
          {message || <i>No message</i>}
        </M.Typography>
      }
      meta={
        !!metadata &&
        !R.isEmpty(metadata) && (
          <JsonDisplay name="Metadata" value={metadata} pl={1.5} py={1.75} pr={2} />
        )
      }
      hash={
        <>
          <M.Box className={classes.hash} component="span" order={{ xs: 1, sm: 0 }}>
            {hash}
          </M.Box>
          <M.IconButton onClick={() => copyToClipboard(hash)} edge={xs ? 'start' : false}>
            <M.Icon>file_copy</M.Icon>
          </M.IconButton>
        </>
      }
      stats={
        <>
          <M.Icon color="disabled">storage</M.Icon>
          &nbsp;&nbsp;
          <M.Typography component="span" variant="body2">
            {readableBytes(stats.bytes)}
          </M.Typography>
          <M.Box pr={2} />
          <M.Icon color="disabled">insert_drive_file</M.Icon>
          &nbsp;
          <M.Typography component="span" variant="body2">
            {readableQuantity(stats.files)}
            &nbsp;
            <FormattedPlural value={stats.files} one="file" other="files" />
          </M.Typography>
        </>
      }
      counts={({ sparklineW, sparklineH }) =>
        AsyncResult.case(
          {
            Ok: (data) => !!data && <Counts {...{ sparklineW, sparklineH, ...data }} />,
            _: () => (
              <>
                <M.Box
                  position="absolute"
                  right={16}
                  top={0}
                  display="flex"
                  alignItems="center"
                  height={20}
                  width={120}
                >
                  <Skeleton height={16} width="100%" borderRadius="borderRadius" />
                </M.Box>
                <SparklineSkel width={sparklineW} height={sparklineH} />
              </>
            ),
          },
          counts,
        )
      }
    />
  )
}

function useRevisionCountData({ bucket, name }) {
  const req = AWS.APIGateway.use()
  return Data.use(requests.countPackageRevisions, { req, bucket, name })
}

function useRevisionsData({ bucket, name, page, perPage }) {
  const req = AWS.APIGateway.use()
  return Data.use(requests.getPackageRevisions, { req, bucket, name, page, perPage })
}

function useCountsData({ bucket, name }) {
  const s3 = AWS.S3.use()
  const { analyticsBucket } = Config.useConfig()
  const today = React.useMemo(() => new Date(), [])
  return Data.use(requests.fetchRevisionsAccessCounts, {
    s3,
    analyticsBucket,
    today,
    window: 30,
    bucket,
    name,
  })
}

const renderRevisionSkeletons = R.times((i) => <RevisionSkel key={i} />)

export default function PackageRevisions({
  match: {
    params: { bucket, name },
  },
  location,
}) {
  const { urls } = NamedRoutes.use()

  const { p } = parseSearch(location.search)
  const page = p && parseInt(p, 10)
  const actualPage = page || 1

  const makePageUrl = React.useCallback(
    (newP) =>
      urls.bucketPackageRevisions(bucket, name, { p: newP !== 1 ? newP : undefined }),
    [urls, bucket, name],
  )

  const scrollRef = React.useRef()

  // scroll to top on page change
  usePrevious(actualPage, (prev) => {
    if (prev && actualPage !== prev && scrollRef.current) {
      scrollRef.current.scrollIntoView()
    }
  })

  const revisionCountData = useRevisionCountData({ bucket, name })
  const revisionsData = useRevisionsData({
    bucket,
    name,
    page: actualPage,
    perPage: PER_PAGE,
  })
  const countsData = useCountsData({ bucket, name })

  const updateDialog = useUpdateDialog({ bucket, name })

  return (
    <M.Box pb={{ xs: 0, sm: 5 }} mx={{ xs: -2, sm: 0 }}>
      {updateDialog.render()}

      <M.Box
        pt={{ xs: 2, sm: 3 }}
        pb={{ xs: 2, sm: 1 }}
        px={{ xs: 2, sm: 0 }}
        display="flex"
      >
        <M.Typography variant="h5" ref={scrollRef}>
          {name}
        </M.Typography>
        <M.Box flexGrow={1} />
        <M.Button
          variant="contained"
          color="primary"
          style={{ marginTop: -3, marginBottom: -3 }}
          onClick={updateDialog.open}
          startIcon={<M.Icon>add</M.Icon>}
        >
          Push revision
        </M.Button>
      </M.Box>

      {revisionCountData.case({
        Err: displayError(),
        _: () => renderRevisionSkeletons(10),
        Ok: (revisionCount) => {
          if (!revisionCount) {
            return (
              <M.Box py={5} textAlign="center">
                <M.Typography variant="h4">No such package</M.Typography>
              </M.Box>
            )
          }

          const pages = Math.ceil(revisionCount / PER_PAGE)

          return (
            <>
              {revisionsData.case({
                Err: displayError(),
                _: () => {
                  const items = actualPage < pages ? PER_PAGE : revisionCount % PER_PAGE
                  return renderRevisionSkeletons(items)
                },
                Ok: R.map((r) => (
                  <Revision
                    key={r.hash}
                    {...{ bucket, name, ...r }}
                    counts={AsyncResult.mapCase(
                      { Ok: R.prop(r.hash) },
                      countsData.result,
                    )}
                  />
                )),
              })}
              {pages > 1 && <Pagination {...{ pages, page: actualPage, makePageUrl }} />}
            </>
          )
        },
      })}
    </M.Box>
  )
}

// TODO: restore linked data
/*
{!!bucketCfg &&
  AsyncResult.case(
    {
      _: () => null,
      Ok: ({ hash, modified, header }) => (
        <React.Suspense fallback={null}>
          <LinkedData.PackageData
            {...{
              bucket: bucketCfg,
              name,
              revision: r,
              hash,
              modified,
              header,
            }}
          />
        </React.Suspense>
      ),
    },
    res,
  )}
*/
