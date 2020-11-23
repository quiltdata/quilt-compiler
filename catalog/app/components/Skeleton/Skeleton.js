import cx from 'classnames'
import * as React from 'react'
import * as M from '@material-ui/core'
import { fade } from '@material-ui/core/styles'

const shimmerSize = '200px'

const useStyles = M.makeStyles((t) => ({
  root: {
    background: t.palette.action.hover,
  },
  '@keyframes wave': {
    '0%': {
      backgroundPosition: `-${shimmerSize} 0`,
    },
    '100%': {
      backgroundPosition: `calc(${shimmerSize} + 100%) 0`,
    },
  },
  animate: {
    animation: '$wave 3s infinite',
    backgroundImage: `linear-gradient(
      90deg,
      ${fade(t.palette.common.white, 0)},
      ${fade(t.palette.common.white, 0.7)},
      ${fade(t.palette.common.white, 0)}
    )`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${shimmerSize} 100%`,
  },
}))

export default React.forwardRef(function Skeleton(
  { className, animate = true, ...props },
  ref,
) {
  const classes = useStyles()
  return (
    <M.Box
      className={cx(className, classes.root, animate && classes.animate)}
      {...props}
      ref={ref}
    />
  )
})
