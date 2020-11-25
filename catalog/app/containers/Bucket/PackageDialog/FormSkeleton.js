import * as React from 'react'
import * as M from '@material-ui/core'

import Skeleton from 'components/Skeleton'

export default function FormSkeleton({ animate }) {
  return (
    <>
      <Skeleton {...{ height: 48, mt: 2, animate }} />
      <Skeleton {...{ height: 48, mt: 3, animate }} />
      <M.Box mt={3}>
        <Skeleton {...{ height: 24, width: 64, animate }} />
        <Skeleton {...{ height: 140, mt: 2, animate }} />
      </M.Box>
      <M.Box mt={3}>
        <M.Box display="flex" mb={2}>
          <Skeleton {...{ height: 24, width: 64, animate }} />
          <M.Box flexGrow={1} />
          <Skeleton {...{ height: 24, width: 64, animate }} />
        </M.Box>
        <M.Box display="flex">
          <Skeleton {...{ height: 32, width: 200, animate }} />
          <Skeleton {...{ height: 32, ml: 0.5, flexGrow: 1, animate }} />
        </M.Box>
        <M.Box display="flex" mt={0.5}>
          <Skeleton {...{ height: 32, width: 200, animate }} />
          <Skeleton {...{ height: 32, ml: 0.5, flexGrow: 1, animate }} />
        </M.Box>
      </M.Box>
      <Skeleton {...{ height: 80, mt: 3, mb: 3, animate }} />
    </>
  )
}
