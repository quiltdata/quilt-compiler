import cx from 'classnames'
import * as dateFns from 'date-fns'
import dedent from 'dedent'
import * as R from 'ramda'
import * as React from 'react'
import { Link as RRLink } from 'react-router-dom'
import * as M from '@material-ui/core'

import { Crumb, copyWithoutSpaces, render as renderCrumbs } from 'components/BreadCrumbs'
import * as Intercom from 'components/Intercom'
import * as Preview from 'components/Preview'
import AsyncResult from 'utils/AsyncResult'
import * as AWS from 'utils/AWS'
import * as BucketConfig from 'utils/BucketConfig'
import * as Config from 'utils/Config'
import Data, { useData } from 'utils/Data'
import * as LinkedData from 'utils/LinkedData'
import * as NamedRoutes from 'utils/NamedRoutes'
import Link, { linkStyle } from 'utils/StyledLink'
import * as s3paths from 'utils/s3paths'
import usePrevious from 'utils/usePrevious'

import Code from './Code'
import CopyButton from './CopyButton'
import * as FileView from './FileView'
import { ListingItem, ListingWithLocalFiltering } from './Listing'
import { usePackageUpdateDialog } from './PackageUpdateDialog'
import { usePackageCopyDialog } from './PackageCopyDialog'
import Section from './Section'
import Summary from './Summary'
import renderPreview from './renderPreview'
import * as requests from './requests'

function useRevisionsData({ bucket, name }) {
  const req = AWS.APIGateway.use()
  return useData(requests.getPackageRevisions, { req, bucket, name, perPage: 5 })
}

const useRevisionInfoStyles = M.makeStyles((t) => ({
  revision: {
    ...linkStyle,
    alignItems: 'center',
    display: 'inline-flex',
  },
  mono: {
    fontFamily: t.typography.monospace.fontFamily,
  },
  line: {
    whiteSpace: 'nowrap',
  },
  secondaryText: {
    display: 'block',
    height: 40,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  list: {
    width: 420,
  },
}))

function RevisionInfo({ revision, bucket, name, path }) {
  const { urls } = NamedRoutes.use()
  const classes = useRevisionInfoStyles()

  const [anchor, setAnchor] = React.useState()
  const [opened, setOpened] = React.useState(false)
  const open = React.useCallback(() => setOpened(true), [])
  const close = React.useCallback(() => setOpened(false), [])

  const data = useRevisionsData({ bucket, name })

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <span className={classes.revision} onClick={open} ref={setAnchor}>
        {revision === 'latest' ? (
          'latest'
        ) : (
          <span className={classes.mono}>{revision}</span>
        )}{' '}
        <M.Icon>expand_more</M.Icon>
      </span>

      <M.Popover
        open={opened && !!anchor}
        anchorEl={anchor}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <M.List className={classes.list}>
          {data.case({
            Ok: R.map((r) => (
              <M.ListItem
                key={r.hash}
                button
                onClick={close}
                selected={r.id === revision}
                component={RRLink}
                to={urls.bucketPackageTree(bucket, name, r.id, path)}
              >
                <M.ListItemText
                  primary={
                    <>
                      <span className={classes.mono}>{r.id}</span>
                      {' | '}
                      {dateFns.format(r.modified, 'MMMM do yyyy - h:mma')}
                    </>
                  }
                  secondary={
                    <span className={classes.secondaryText}>
                      <span className={classes.line}>
                        {r.message || <i>No message</i>}
                      </span>
                      <br />
                      <span className={cx(classes.line, classes.mono)}>{r.hash}</span>
                    </span>
                  }
                />
              </M.ListItem>
            )),
            Err: () => (
              <M.ListItem>
                <M.ListItemIcon>
                  <M.Icon>error</M.Icon>
                </M.ListItemIcon>
                <M.Typography variant="body1">Error fetching revisions</M.Typography>
              </M.ListItem>
            ),
            _: () => (
              <M.ListItem>
                <M.ListItemIcon>
                  <M.CircularProgress size={24} />
                </M.ListItemIcon>
                <M.Typography variant="body1">Fetching revisions</M.Typography>
              </M.ListItem>
            ),
          })}
          <M.Divider />
          <M.ListItem
            button
            onClick={close}
            component={RRLink}
            to={urls.bucketPackageRevisions(bucket, name)}
          >
            <M.Box textAlign="center" width="100%">
              Show all revisions
            </M.Box>
          </M.ListItem>
        </M.List>
      </M.Popover>
    </>
  )
}

function ExposeLinkedData({ bucketCfg, bucket, name, revision }) {
  const s3 = AWS.S3.use()
  const sign = AWS.Signer.useS3Signer()
  const { apiGatewayEndpoint: endpoint } = Config.use()
  const data = useData(requests.getRevisionData, {
    s3,
    sign,
    endpoint,
    bucket,
    name,
    id: revision,
    maxKeys: 0,
  })
  return data.case({
    _: () => null,
    Ok: ({ hash, modified, header }) => (
      <React.Suspense fallback={null}>
        <LinkedData.PackageData
          {...{ bucket: bucketCfg, name, revision, hash, modified, header }}
        />
      </React.Suspense>
    ),
  })
}

function PkgCode({ data, bucket, name, revision, path }) {
  const code = data.case({
    Ok: ({ hash }) => {
      const nameWithPath = JSON.stringify(s3paths.ensureNoSlash(`${name}/${path}`))
      const hashDisplay = revision === 'latest' ? '' : hash.substring(0, 10)
      const hashPy = hashDisplay && `, top_hash="${hashDisplay}"`
      const hashCli = hashDisplay && ` --top-hash ${hashDisplay}`
      return [
        {
          label: 'Python',
          hl: 'python',
          contents: dedent`
            import quilt3
            # browse
            p = quilt3.Package.browse("${name}"${hashPy}, registry="s3://${bucket}")
            # download (be mindful of large packages)
            quilt3.Package.install(${nameWithPath}${hashPy}, registry="s3://${bucket}", dest=".")
          `,
        },
        {
          label: 'CLI',
          hl: 'bash',
          contents: dedent`
            quilt3 install ${nameWithPath}${hashCli} --registry s3://${bucket} --dest .
          `,
        },
      ]
    },
    _: () => null,
  })
  return code && <Code>{code}</Code>
}

const useTopBarStyles = M.makeStyles((t) => ({
  topBar: {
    alignItems: 'flex-end',
    display: 'flex',
    marginBottom: t.spacing(2),
    marginTop: t.spacing(0.5),
  },
  crumbs: {
    ...t.typography.body1,
    maxWidth: 'calc(100% - 160px)',
    overflowWrap: 'break-word',
    [t.breakpoints.down('xs')]: {
      maxWidth: 'calc(100% - 40px)',
    },
  },
  spacer: {
    flexGrow: 1,
  },
}))

function TopBar({ crumbs, children }) {
  const classes = useTopBarStyles()
  return (
    <div className={classes.topBar}>
      <div className={classes.crumbs} onCopy={copyWithoutSpaces}>
        {renderCrumbs(crumbs)}
      </div>
      <div className={classes.spacer} />
      {children}
    </div>
  )
}

function DirDisplay({ bucket, name, revision, path, crumbs, onRevisionPush }) {
  const s3 = AWS.S3.use()
  const { apiGatewayEndpoint: endpoint, noDownload } = Config.use()
  const credentials = AWS.Credentials.use()
  const { urls } = NamedRoutes.use()
  const intercom = Intercom.use()

  const showIntercom = React.useMemo(
    () => (intercom.dummy ? null : () => intercom('show')),
    [intercom],
  )

  const data = useData(requests.packageSelect, {
    s3,
    credentials,
    endpoint,
    bucket,
    name,
    revision,
    prefix: path,
  })

  const hashData = useData(requests.loadRevisionHash, { s3, bucket, name, id: revision })

  const mkUrl = React.useCallback(
    (handle) => urls.bucketPackageTree(bucket, name, revision, handle.logicalKey),
    [urls, bucket, name, revision],
  )

  const updateDialog = usePackageUpdateDialog({
    bucket,
    name,
    revision,
    onExited: onRevisionPush,
  })

  const copyDialog = usePackageCopyDialog({
    bucket,
    name,
    revision,
    onExited: onRevisionPush,
  })

  usePrevious({ bucket, name, revision }, (prev) => {
    // close the dialog when navigating away
    if (!R.equals({ bucket, name, revision }, prev)) updateDialog.close()
  })

  return data.case({
    Ok: ({ objects, prefixes, meta }) => {
      const up =
        path === ''
          ? []
          : [
              ListingItem.Dir({
                name: '..',
                to: urls.bucketPackageTree(bucket, name, revision, s3paths.up(path)),
              }),
            ]
      const dirs = prefixes.map((p) =>
        ListingItem.Dir({
          name: s3paths.ensureNoSlash(p),
          to: urls.bucketPackageTree(bucket, name, revision, path + p),
        }),
      )
      const files = objects.map((o) =>
        ListingItem.File({
          name: o.name,
          to: urls.bucketPackageTree(bucket, name, revision, path + o.name),
          size: o.size,
        }),
      )
      const items = [...up, ...dirs, ...files]
      const summaryHandles = objects.map((o) => ({
        ...s3paths.parseS3Url(o.physicalKey),
        logicalKey: path + o.name,
      }))
      return (
        <>
          {updateDialog.render()}
          {copyDialog.render()}
          <TopBar crumbs={crumbs}>
            <CopyButton bucket={bucket} onChange={copyDialog.open} />
            <M.Box ml={1} />
            <M.Button
              variant="contained"
              color="primary"
              size="small"
              style={{ marginTop: -3, marginBottom: -3, flexShrink: 0 }}
              onClick={updateDialog.open}
              startIcon={<M.Icon>add</M.Icon>}
            >
              Push revision
            </M.Button>
            {!noDownload &&
              hashData.case({
                Ok: ({ hash }) => (
                  <>
                    <M.Box ml={1} />
                    <FileView.ZipDownloadForm
                      label="Download package"
                      suffix={`package/${bucket}/${name}/${hash}`}
                    />
                  </>
                ),
                _: () => null,
              })}
          </TopBar>
          <PkgCode {...{ data: hashData, bucket, name, revision, path }} />
          <FileView.Meta data={AsyncResult.Ok(meta)} />
          <M.Box mt={2}>
            <ListingWithLocalFiltering items={items} />
            <Summary files={summaryHandles} mkUrl={mkUrl} />
          </M.Box>
        </>
      )
    },
    Err: (e) => {
      let heading = 'Error loading directory'
      let body = "Seems like there's no such directory in this package"
      if (e.status === 500 && /Could not reserve memory block/.test(e.message)) {
        heading = 'Oops, this is a large package'
        body = (
          <>
            The Lambda process ran out of memory
            {!!showIntercom && (
              <>
                , but don&apos;t worry,{' '}
                {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
                <Link component="span" role="button" onClick={showIntercom}>
                  we can fix it
                </Link>
              </>
            )}
            .
          </>
        )
      }
      return (
        <>
          <TopBar crumbs={crumbs} />
          <M.Box mt={4}>
            <M.Typography variant="h4" align="center" gutterBottom>
              {heading}
            </M.Typography>
            <M.Typography variant="body1" align="center">
              {body}
            </M.Typography>
          </M.Box>
        </>
      )
    },
    _: () => (
      // TODO: skeleton placeholder
      <>
        <TopBar crumbs={crumbs} />
        <M.Box mt={2}>
          <M.CircularProgress />
        </M.Box>
      </>
    ),
  })
}

function FileDisplay({ bucket, name, revision, path, crumbs }) {
  const s3 = AWS.S3.use()
  const credentials = AWS.Credentials.use()
  const { apiGatewayEndpoint: endpoint, noDownload } = Config.use()

  const data = useData(requests.packageFileDetail, {
    s3,
    credentials,
    endpoint,
    bucket,
    name,
    revision,
    path,
  })

  const hashData = useData(requests.loadRevisionHash, { s3, bucket, name, id: revision })

  const renderProgress = () => (
    // TODO: skeleton placeholder
    <>
      <TopBar crumbs={crumbs} />
      <M.Box mt={2}>
        <M.CircularProgress />
      </M.Box>
    </>
  )

  const renderError = (headline, detail) => (
    <>
      <TopBar crumbs={crumbs} />
      <M.Box mt={4}>
        <M.Typography variant="h4" align="center" gutterBottom>
          {headline}
        </M.Typography>
        {!!detail && (
          <M.Typography variant="body1" align="center">
            {detail}
          </M.Typography>
        )}
      </M.Box>
    </>
  )

  const withPreview = ({ archived, deleted, handle }, callback) => {
    if (deleted) {
      return callback(AsyncResult.Err(Preview.PreviewError.Deleted({ handle })))
    }
    if (archived) {
      return callback(AsyncResult.Err(Preview.PreviewError.Archived({ handle })))
    }
    return Preview.load(handle, callback)
  }

  return data.case({
    Ok: ({ meta, ...handle }) => (
      <Data fetch={requests.getObjectExistence} params={{ s3, ...handle }}>
        {AsyncResult.case({
          _: renderProgress,
          Err: (e) => {
            if (e.code === 'Forbidden') {
              return renderError('Access Denied', "You don't have access to this object")
            }
            // eslint-disable-next-line no-console
            console.error(e)
            return renderError('Error loading file', 'Something went wrong')
          },
          Ok: requests.ObjectExistence.case({
            Exists: ({ archived, deleted }) => (
              <>
                <TopBar crumbs={crumbs}>
                  {!noDownload && !deleted && !archived && (
                    <FileView.DownloadButton handle={handle} />
                  )}
                </TopBar>
                <PkgCode {...{ data: hashData, bucket, name, revision, path }} />
                <FileView.Meta data={AsyncResult.Ok(meta)} />
                <Section icon="remove_red_eye" heading="Preview" expandable={false}>
                  {withPreview({ archived, deleted, handle }, renderPreview)}
                </Section>
              </>
            ),
            _: () => renderError('No Such Object'),
          }),
        })}
      </Data>
    ),
    Err: (e) => {
      // eslint-disable-next-line no-console
      console.error(e)
      return renderError(
        'Error loading file',
        "Seems like there's no such file in this package",
      )
    },
    _: renderProgress,
  })
}

const useStyles = M.makeStyles(() => ({
  name: {
    wordBreak: 'break-all',
  },
}))

export default function PackageTree({
  match: {
    params: { bucket, name, revision = 'latest', path: encodedPath = '' },
  },
}) {
  const classes = useStyles()
  const { urls } = NamedRoutes.use()
  const bucketCfg = BucketConfig.useCurrentBucketConfig()

  const path = s3paths.decode(encodedPath)
  const isDir = s3paths.isDir(path)

  const crumbs = React.useMemo(() => {
    const segments = [{ label: 'ROOT', path: '' }, ...s3paths.getBreadCrumbs(path)]
    return R.intersperse(
      Crumb.Sep(<>&nbsp;/ </>),
      segments.map(({ label, path: segPath }) =>
        Crumb.Segment({
          label,
          to:
            path === segPath
              ? undefined
              : urls.bucketPackageTree(bucket, name, revision, segPath),
        }),
      ),
    ).concat(path.endsWith('/') ? Crumb.Sep(<>&nbsp;/</>) : [])
  }, [bucket, name, revision, path, urls])

  const [revisionKey, setRevisionKey] = React.useState(1)
  const [revisionListKey, setRevisionListKey] = React.useState(1)

  const onRevisionPush = React.useCallback(
    (res) => {
      const pushedSamePackage = R.pathEq(['pushed', 'name'], name, res)
      if (pushedSamePackage) {
        // refresh revision list if a new revision of the current package has been pushed
        setRevisionListKey(R.inc)
        if (revision === 'latest') {
          // when browsing 'latest' revision, also refresh the pacakge view
          setRevisionKey(R.inc)
        }
      }
    },
    [name, revision, setRevisionKey, setRevisionListKey],
  )

  return (
    <FileView.Root>
      {!!bucketCfg && (
        <ExposeLinkedData
          {...{ bucketCfg, bucket, name, revision }}
          key={`links:${revisionKey}`}
        />
      )}
      <M.Typography variant="body1">
        <Link to={urls.bucketPackageDetail(bucket, name)} className={classes.name}>
          {name}
        </Link>
        {' @ '}
        <RevisionInfo
          {...{ revision, bucket, name, path }}
          key={`revinfo:${revisionListKey}`}
        />
      </M.Typography>

      {isDir ? (
        <DirDisplay
          {...{ bucket, name, revision, path, crumbs, onRevisionPush }}
          key={`dir:${revisionKey}`}
        />
      ) : (
        <FileDisplay {...{ bucket, name, revision, path, crumbs }} />
      )}
    </FileView.Root>
  )
}
