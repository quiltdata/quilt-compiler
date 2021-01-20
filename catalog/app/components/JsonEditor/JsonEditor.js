import cx from 'classnames'
import * as R from 'ramda'
import * as React from 'react'
import * as M from '@material-ui/core'

import { EMPTY_SCHEMA } from 'utils/json-schema'
import Column from './Column'
import State from './State'

const useStyles = M.makeStyles((t) => ({
  disabled: {
    position: 'relative',
    '&:after': {
      background: 'rgba(255,255,255,0.9)',
      bottom: 0,
      content: '""',
      cursor: 'not-allowed',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
      zIndex: 1,
    },
  },
  inner: {
    display: 'flex',
    maxHeight: t.spacing(74),
    overflow: 'auto',
  },
}))

function JsonEditor({
  addRow,
  changeValue,
  className,
  disabled,
  columns,
  jsonDict,
  fieldPath,
  makeAction,
  onChange,
  setFieldPath,
}) {
  const classes = useStyles()

  const onMenuAction = React.useCallback(
    (contextFieldPath, action) => {
      const newData = makeAction(contextFieldPath, action)
      if (newData) {
        onChange(newData)
      }
    },
    [makeAction, onChange],
  )

  const onChangeInternal = React.useCallback(
    (...args) => {
      const newData = changeValue(...args)
      if (newData) {
        onChange(newData)
      }
    },
    [changeValue, onChange],
  )

  const columnData = R.last(columns)

  return (
    <div className={cx({ [classes.disabled]: disabled }, className)}>
      <div className={classes.inner}>
        <Column
          {...{
            columnPath: fieldPath,
            data: columnData,
            jsonDict,
            key: fieldPath,
            onAddRow: addRow,
            onBreadcrumb: setFieldPath,
            onExpand: setFieldPath,
            onMenuAction,
            onChange: onChangeInternal,
          }}
        />
      </div>
    </div>
  )
}

export default function JsonEditorStateWrapper({
  className,
  disabled,
  onChange,
  schema: optSchema,
  value,
}) {
  const schema = optSchema || EMPTY_SCHEMA

  return (
    <State obj={value} schema={schema}>
      {(props) => (
        <JsonEditor
          {...{
            className,
            disabled,
            onChange,
          }}
          {...props}
        />
      )}
    </State>
  )
}
