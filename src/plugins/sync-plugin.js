/**
 * @module bindings/prosemirror
 */

import { createMutex } from 'lib0/mutex.js'
import * as PModel from 'prosemirror-model'
import { EditorView,  Decoration, DecorationSet } from 'prosemirror-view' // eslint-disable-line
import { Plugin, PluginKey, EditorState, TextSelection } from 'prosemirror-state' // eslint-disable-line
import * as math from 'lib0/math.js'
import * as object from 'lib0/object.js'
import { simpleDiff } from 'lib0/diff.js'
import * as error from 'lib0/error.js'
import * as Y from 'yjs'
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from '../lib.js'

export const isVisible = (item, snapshot) => snapshot === undefined ? !item._deleted : (snapshot.sm.has(item._id.user) && snapshot.sm.get(item._id.user) > item._id.clock && !snapshot.ds.isDeleted(item._id))

/**
 * Either a node if type is YXmlElement or an Array of text nodes if YXmlText
 * @typedef {Map<Y.AbstractType, PModel.Node | Array<PModel.Node>>} ProsemirrorMapping
 */

/**
 * The unique prosemirror plugin key for prosemirrorPlugin.
 *
 * @public
 */
export const ySyncPluginKey = new PluginKey('y-sync')

/**
 * This plugin listens to changes in prosemirror view and keeps yXmlState and view in sync.
 *
 * This plugin also keeps references to the type and the shared document so other plugins can access it.
 * @param {Y.XmlFragment} yXmlFragment
 * @return {Plugin} Returns a prosemirror plugin that binds to this type
 */
export const ySyncPlugin = yXmlFragment => {
  let changedInitialContent = false
  const plugin = new Plugin({
    props: {
      editable: (state) => ySyncPluginKey.getState(state).snapshot == null
    },
    key: ySyncPluginKey,
    state: {
      init: (initargs, state) => {
        return {
          type: yXmlFragment,
          doc: yXmlFragment.doc,
          binding: null,
          snapshot: null,
          isChangeOrigin: false
        }
      },
      apply: (tr, pluginState) => {
        const change = tr.getMeta(ySyncPluginKey)
        if (change !== undefined) {
          pluginState = Object.assign({}, pluginState)
          for (let key in change) {
            pluginState[key] = change[key]
          }
        }
        // always set isChangeOrigin. If undefined, this is not change origin.
        pluginState.isChangeOrigin = change !== undefined && !!change.isChangeOrigin
        if (pluginState.binding !== null) {
          if (change !== undefined && change.snapshot !== undefined) {
            // snapshot changed, rerender next
            setTimeout(() => {
              if (change.restore == null) {
                pluginState.binding._renderSnapshot(change.snapshot, change.prevSnapshot)
              } else {
                pluginState.binding._renderSnapshot(change.snapshot, change.snapshot)
                // reset to current prosemirror state
                delete pluginState.restore
                delete pluginState.snapshot
                delete pluginState.prevSnapshot
                pluginState.binding._prosemirrorChanged(pluginState.binding.prosemirrorView.state.doc)
              }
            }, 0)
          }
        }
        return pluginState
      }
    },
    view: view => {
      const binding = new ProsemirrorBinding(yXmlFragment, view)
      // Make sure this is called in a separate context
      setTimeout(() => {
        view.dispatch(view.state.tr.setMeta(ySyncPluginKey, { binding }))
      }, 0)
      return {
        update: () => {
          const pluginState = plugin.getState(view.state)
          if (pluginState.snapshot == null) {
            if (changedInitialContent || view.state.doc.content.size > 2) {
              changedInitialContent = true
              binding._prosemirrorChanged(view.state.doc)
            }
          }
        },
        destroy: () => {
          binding.destroy()
        }
      }
    }
  })
  return plugin
}

/**
 * @param {any} tr
 * @param {any} relSel
 * @param {ProsemirrorBinding} binding
 */
const restoreRelativeSelection = (tr, relSel, binding) => {
  if (relSel !== null && relSel.anchor !== null && relSel.head !== null) {
    const anchor = relativePositionToAbsolutePosition(binding.doc, binding.type, relSel.anchor, binding.mapping)
    const head = relativePositionToAbsolutePosition(binding.doc, binding.type, relSel.head, binding.mapping)
    if (anchor !== null && head !== null) {
      tr = tr.setSelection(TextSelection.create(tr.doc, anchor, head))
    }
  }
}

export const getRelativeSelection = (pmbinding, state) => ({
  anchor: absolutePositionToRelativePosition(state.selection.anchor, pmbinding.type, pmbinding.mapping),
  head: absolutePositionToRelativePosition(state.selection.head, pmbinding.type, pmbinding.mapping)
})

/**
 * Binding for prosemirror.
 *
 * @protected
 */
export class ProsemirrorBinding {
  /**
   * @param {Y.XmlFragment} yXmlFragment The bind source
   * @param {EditorView} prosemirrorView The target binding
   */
  constructor (yXmlFragment, prosemirrorView) {
    this.type = yXmlFragment
    this.prosemirrorView = prosemirrorView
    this.mux = createMutex()
    /**
     * @type {ProsemirrorMapping}
     */
    this.mapping = new Map()
    this._observeFunction = this._typeChanged.bind(this)
    /**
     * @type {Y.Doc}
     */
    // @ts-ignore
    this.doc = yXmlFragment.doc
    /**
     * current selection as relative positions in the Yjs model
     */
    this.beforeTransactionSelection = null
    this.doc.on('beforeTransaction', e => {
      this.beforeTransactionSelection = getRelativeSelection(this, prosemirrorView.state)
    })
    yXmlFragment.observeDeep(this._observeFunction)
  }
  _forceRerender () {
    this.mapping = new Map()
    this.mux(() => {
      const fragmentContent = this.type.toArray().map(t => createNodeFromYElement(/** @type {Y.XmlElement} */ (t), this.prosemirrorView.state.schema, this.mapping)).filter(n => n !== null)
      const tr = this.prosemirrorView.state.tr.replace(0, this.prosemirrorView.state.doc.content.size, new PModel.Slice(new PModel.Fragment(fragmentContent), 0, 0))
      this.prosemirrorView.dispatch(tr)
    })
  }
  /**
   *
   * @param {Y.Snapshot} snapshot
   * @param {Y.Snapshot} prevSnapshot
   */
  _renderSnapshot (snapshot, prevSnapshot) {
    // clear mapping because we are going to rerender
    this.mapping = new Map()
    this.mux(() => {
      const fragmentContent = Y.typeListToArraySnapshot(this.type, new Y.Snapshot(prevSnapshot.ds, snapshot.sm)).map(t => createNodeFromYElement(t, this.prosemirrorView.state.schema, new Map(), snapshot, prevSnapshot)).filter(n => n !== null)
      const tr = this.prosemirrorView.state.tr.replace(0, this.prosemirrorView.state.doc.content.size, new PModel.Slice(new PModel.Fragment(fragmentContent), 0, 0))
      this.prosemirrorView.dispatch(tr)
    })
  }
  /**
   * @param {Array<Y.YEvent>} events
   * @param {Y.Transaction} transaction
   */
  _typeChanged (events, transaction) {
    if (events.length === 0 || ySyncPluginKey.getState(this.prosemirrorView.state).snapshot != null) {
      // drop out if snapshot is active
      return
    }
    this.mux(() => {
      /**
       * @param {any} _
       * @param {Y.AbstractType} type
       */
      const delType = (_, type) => this.mapping.delete(type)
      Y.iterateDeletedStructs(transaction, transaction.deleteSet, this.doc.store, struct => struct.constructor === Y.Item && this.mapping.delete(/** @type {Y.ContentType} */ (/** @type {Y.Item} */ (struct).content).type))
      transaction.changed.forEach(delType)
      transaction.changedParentTypes.forEach(delType)
      const fragmentContent = this.type.toArray().map(t => createNodeIfNotExists(/** @type {Y.XmlElement | Y.XmlHook} */ (t), this.prosemirrorView.state.schema, this.mapping)).filter(n => n !== null)
      let tr = this.prosemirrorView.state.tr.replace(0, this.prosemirrorView.state.doc.content.size, new PModel.Slice(new PModel.Fragment(fragmentContent), 0, 0))
      restoreRelativeSelection(tr, this.beforeTransactionSelection, this)
      tr = tr.setMeta(ySyncPluginKey, { isChangeOrigin: true })
      if (this.beforeTransactionSelection !== null && this.prosemirrorView.hasFocus()) {
        tr.scrollIntoView()
      }
      this.prosemirrorView.dispatch(tr)
    })
  }
  _prosemirrorChanged (doc) {
    this.mux(() => {
      updateYFragment(this.doc, this.type, doc, this.mapping)
    })
  }
  destroy () {
    this.type.unobserveDeep(this._observeFunction)
  }
}

/**
 * @private
 * @param {Y.XmlElement | Y.XmlHook} el
 * @param {PModel.Schema} schema
 * @param {ProsemirrorMapping} mapping
 * @param {Y.Snapshot} [snapshot]
 * @param {Y.Snapshot} [prevSnapshot]
 * @return {PModel.Node | null}
 */
export const createNodeIfNotExists = (el, schema, mapping, snapshot, prevSnapshot) => {
  const node = /** @type {PModel.Node} */ (mapping.get(el))
  if (node === undefined) {
    if (el instanceof Y.XmlElement) {
      return createNodeFromYElement(el, schema, mapping, snapshot, prevSnapshot)
    } else {
      throw error.methodUnimplemented() // we are currently not handling hooks
    }
  }
  return node
}

/**
 * @private
 * @param {Y.XmlElement} el
 * @param {PModel.Schema} schema
 * @param {ProsemirrorMapping} mapping
 * @param {Y.Snapshot} [snapshot]
 * @param {Y.Snapshot} [prevSnapshot]
 * @return {PModel.Node | null} Returns node if node could be created. Otherwise it deletes the yjs type and returns null
 */
export const createNodeFromYElement = (el, schema, mapping, snapshot, prevSnapshot) => {
  let _snapshot = snapshot
  let _prevSnapshot = prevSnapshot
  if (snapshot !== undefined && prevSnapshot !== undefined) {
    if (!isVisible(el, snapshot)) {
      // if this element is already rendered as deleted (ychange), then do not render children as deleted
      _snapshot = new Y.Snapshot(prevSnapshot.ds, snapshot.sm)
      _prevSnapshot = _snapshot
    } else if (!isVisible(el, prevSnapshot)) {
      _prevSnapshot = _snapshot
    }
  }
  const children = []
  const createChildren = type => {
    if (type.constructor === Y.XmlElement) {
      const n = createNodeIfNotExists(type, schema, mapping, _snapshot, _prevSnapshot)
      if (n !== null) {
        children.push(n)
      }
    } else {
      const ns = createTextNodesFromYText(type, schema, mapping, _snapshot, _prevSnapshot)
      if (ns !== null) {
        ns.forEach(textchild => {
          if (textchild !== null) {
            children.push(textchild)
          }
        })
      }
    }
  }
  if (snapshot === undefined || prevSnapshot === undefined) {
    el.toArray().forEach(createChildren)
  } else {
    Y.typeListToArraySnapshot(el, new Y.Snapshot(prevSnapshot.ds, snapshot.sm)).forEach(createChildren)
  }
  try {
    const attrs = el.getAttributes(_snapshot)
    if (snapshot !== undefined) {
      if (!isVisible(el, snapshot)) {
        attrs.ychange = { client: /** @type {Y.Item} */ (el._item).id.client, state: 'removed' }
      } else if (!isVisible(el, prevSnapshot)) {
        attrs.ychange = { client: /** @type {Y.Item} */ (el._item).id.client, state: 'added' }
      }
    }
    const node = schema.node(el.nodeName, attrs, children)
    mapping.set(el, node)
    return node
  } catch (e) {
    // an error occured while creating the node. This is probably a result of a concurrent action.
    /** @type {Y.Doc} */ (el.doc).transact(transaction => {
      /** @type {Y.Item} */ (el._item).delete(transaction)
    })
    mapping.delete(el)
    return null
  }
}

/**
 * @private
 * @param {Y.XmlText} text
 * @param {PModel.Schema} schema
 * @param {ProsemirrorMapping} mapping
 * @param {Y.Snapshot} [snapshot]
 * @param {Y.Snapshot} [prevSnapshot]
 * @return {Array<PModel.Node>|null}
 */
export const createTextNodesFromYText = (text, schema, mapping, snapshot, prevSnapshot) => {
  const nodes = []
  const deltas = text.toDelta(snapshot, prevSnapshot)
  try {
    for (let i = 0; i < deltas.length; i++) {
      const delta = deltas[i]
      const marks = []
      for (let markName in delta.attributes) {
        marks.push(schema.mark(markName, delta.attributes[markName]))
      }
      nodes.push(schema.text(delta.insert, marks))
    }
  } catch (e) {
    // an error occured while creating the node. This is probably a result of a concurrent action.
    /** @type {Y.Doc} */ (text.doc).transact(transaction => {
      /** @type {Y.Item} */ (text._item).delete(transaction)
    })
    return null
  }
  // @ts-ignore
  return nodes
}

/**
 * @private
 * @param {Array<PModel.Node>} nodes prosemirror node
 * @param {ProsemirrorMapping} mapping
 * @return {Y.XmlText}
 */
export const createTypeFromTextNodes = (nodes, mapping) => {
  const type = new Y.XmlText()
  const delta = nodes.map(node => ({
    // @ts-ignore
    insert: node.text,
    attributes: marksToAttributes(node.marks)
  }))
  type.applyDelta(delta)
  mapping.set(type, nodes)
  return type
}

/**
 * @private
 * @param {PModel.Node} node prosemirror node
 * @param {ProsemirrorMapping} mapping
 * @return {Y.XmlElement}
 */
export const createTypeFromElementNode = (node, mapping) => {
  const type = new Y.XmlElement(node.type.name)
  for (let key in node.attrs) {
    const val = node.attrs[key]
    if (val !== null && key !== 'ychange') {
      type.setAttribute(key, val)
    }
  }
  type.insert(0, normalizePNodeContent(node).map(n => createTypeFromTextOrElementNode(n, mapping)))
  mapping.set(type, node)
  return type
}

/**
 * @private
 * @param {PModel.Node|Array<PModel.Node>} node prosemirror text node
 * @param {ProsemirrorMapping} mapping
 * @return {Y.XmlElement|Y.XmlText}
 */
export const createTypeFromTextOrElementNode = (node, mapping) => node instanceof Array ? createTypeFromTextNodes(node, mapping) : createTypeFromElementNode(node, mapping)

const equalAttrs = (pattrs, yattrs) => {
  const keys = Object.keys(pattrs).filter(key => pattrs[key] !== null)
  let eq = keys.length === Object.keys(yattrs).filter(key => yattrs[key] !== null).length
  for (let i = 0; i < keys.length && eq; i++) {
    const key = keys[i]
    const l = pattrs[key]
    const r = yattrs[key]
    eq = key === 'ychange' || l === r || (typeof l === 'object' && typeof r === 'object' && equalAttrs(l, r))
  }
  return eq
}

/**
 * @typedef {Array<Array<PModel.Node>|PModel.Node>} NormalizedPNodeContent
 */

/**
 * @param {PModel.Node} pnode
 * @return {NormalizedPNodeContent}
 */
export const normalizePNodeContent = pnode => {
  const c = pnode.content.content
  const res = []
  for (let i = 0; i < c.length; i++) {
    const n = c[i]
    if (n.isText) {
      const textNodes = []
      for (let tnode = c[i]; i < c.length && tnode.isText; tnode = c[++i]) {
        textNodes.push(tnode)
      }
      i--
      res.push(textNodes)
    } else {
      res.push(n)
    }
  }
  return res
}

/**
 * @param {Y.XmlText} ytext
 * @param {Array<PModel.Node>} ptexts
 */
const equalYTextPText = (ytext, ptexts) => {
  const delta = ytext.toDelta()
  return delta.length === ptexts.length && delta.every((d, i) => d.insert === /** @type {any} */ (ptexts[i]).text && object.keys(d.attributes || {}).length === ptexts[i].marks.length && ptexts[i].marks.every(mark => equalAttrs(d.attributes[mark.type.name] || {}, mark.attrs)))
}

/**
 * @param {Y.XmlElement|Y.XmlText|Y.XmlHook} ytype
 * @param {PModel.Node|Array<PModel.Node>} pnode
 */
const equalYTypePNode = (ytype, pnode) => {
  if (ytype instanceof Y.XmlElement && !(pnode instanceof Array) && matchNodeName(ytype, pnode)) {
    const normalizedContent = normalizePNodeContent(pnode)
    return ytype._length === normalizedContent.length && equalAttrs(ytype.getAttributes(), pnode.attrs) && ytype.toArray().every((ychild, i) => equalYTypePNode(ychild, normalizedContent[i]))
  }
  return ytype instanceof Y.XmlText && pnode instanceof Array && equalYTextPText(ytype, pnode)
}

/**
 * @param {PModel.Node | Array<PModel.Node> | undefined} mapped
 * @param {PModel.Node | Array<PModel.Node>} pcontent
 */
const mappedIdentity = (mapped, pcontent) => mapped === pcontent || (mapped instanceof Array && pcontent instanceof Array && mapped.length === pcontent.length && mapped.every((a, i) => pcontent[i] === a))

/**
 * @param {Y.XmlElement} ytype
 * @param {PModel.Node} pnode
 * @param {ProsemirrorMapping} mapping
 * @return {{ foundMappedChild: boolean, equalityFactor: number }}
 */
const computeChildEqualityFactor = (ytype, pnode, mapping) => {
  const yChildren = ytype.toArray()
  const pChildren = normalizePNodeContent(pnode)
  const pChildCnt = pChildren.length
  const yChildCnt = yChildren.length
  const minCnt = math.min(yChildCnt, pChildCnt)
  let left = 0
  let right = 0
  let foundMappedChild = false
  for (; left < minCnt; left++) {
    const leftY = yChildren[left]
    const leftP = pChildren[left]
    if (mappedIdentity(mapping.get(leftY), leftP)) {
      foundMappedChild = true// definite (good) match!
    } else if (!equalYTypePNode(leftY, leftP)) {
      break
    }
  }
  for (; left + right < minCnt; right++) {
    const rightY = yChildren[yChildCnt - right - 1]
    const rightP = pChildren[pChildCnt - right - 1]
    if (mappedIdentity(mapping.get(rightY), rightP)) {
      foundMappedChild = true
    } else if (!equalYTypePNode(rightY, rightP)) {
      break
    }
  }
  return {
    equalityFactor: left + right,
    foundMappedChild
  }
}

const ytextTrans = ytext => {
  let str = ''
  /**
   * @type {Y.Item|null}
   */
  let n = ytext._start
  const nAttrs = {}
  while (n !== null) {
    if (!n.deleted) {
      if (n.countable && n.content instanceof Y.ContentString) {
        str += n.content.str
      } else if (n.content instanceof Y.ContentFormat) {
        nAttrs[n.content.key] = null
      }
    }
    n = n.right
  }
  return {
    str,
    nAttrs
  }
}

/**
 * @todo test this more
 *
 * @param {Y.Text} ytext
 * @param {Array<PModel.Node>} ptexts
 * @param {ProsemirrorMapping} mapping
 */
const updateYText = (ytext, ptexts, mapping) => {
  mapping.set(ytext, ptexts)
  const { nAttrs, str } = ytextTrans(ytext)
  const content = ptexts.map(p => ({ insert: /** @type {any} */ (p).text, attributes: Object.assign({}, nAttrs, marksToAttributes(p.marks)) }))
  const { insert, remove, index } = simpleDiff(str, content.map(c => c.insert).join(''))
  ytext.delete(index, remove)
  ytext.insert(index, insert)
  ytext.applyDelta(content.map(c => ({ retain: c.insert.length, attributes: c.attributes })))
}

const marksToAttributes = marks => {
  const pattrs = {}
  marks.forEach(mark => {
    if (mark.type.name !== 'ychange') {
      pattrs[mark.type.name] = mark.attrs
    }
  })
  return pattrs
}

/**
 * @private
 * @param {Y.Doc} y
 * @param {Y.XmlFragment} yDomFragment
 * @param {PModel.Node} pNode
 * @param {ProsemirrorMapping} mapping
 */
const updateYFragment = (y, yDomFragment, pNode, mapping) => {
  if (yDomFragment instanceof Y.XmlElement && yDomFragment.nodeName !== pNode.type.name) {
    throw new Error('node name mismatch!')
  }
  mapping.set(yDomFragment, pNode)
  // update attributes
  if (yDomFragment instanceof Y.XmlElement) {
    const yDomAttrs = yDomFragment.getAttributes()
    const pAttrs = pNode.attrs
    for (let key in pAttrs) {
      if (pAttrs[key] !== null) {
        if (yDomAttrs[key] !== pAttrs[key] && key !== 'ychange') {
          yDomFragment.setAttribute(key, pAttrs[key])
        }
      } else {
        yDomFragment.removeAttribute(key)
      }
    }
    // remove all keys that are no longer in pAttrs
    for (let key in yDomAttrs) {
      if (pAttrs[key] === undefined) {
        yDomFragment.removeAttribute(key)
      }
    }
  }
  // update children
  const pChildren = normalizePNodeContent(pNode)
  const pChildCnt = pChildren.length
  const yChildren = yDomFragment.toArray()
  const yChildCnt = yChildren.length
  const minCnt = math.min(pChildCnt, yChildCnt)
  let left = 0
  let right = 0
  // find number of matching elements from left
  for (;left < minCnt; left++) {
    const leftY = yChildren[left]
    const leftP = pChildren[left]
    if (!mappedIdentity(mapping.get(leftY), leftP)) {
      if (equalYTypePNode(leftY, leftP)) {
        // update mapping
        mapping.set(leftY, leftP)
      } else {
        break
      }
    }
  }
  // find number of matching elements from right
  for (;right + left + 1 < minCnt; right++) {
    const rightY = yChildren[yChildCnt - right - 1]
    const rightP = pChildren[pChildCnt - right - 1]
    if (!mappedIdentity(mapping.get(rightY), rightP)) {
      if (equalYTypePNode(rightY, rightP)) {
        // update mapping
        mapping.set(rightY, rightP)
      } else {
        break
      }
    }
  }
  y.transact(() => {
    // try to compare and update
    while (yChildCnt - left - right > 0 && pChildCnt - left - right > 0) {
      const leftY = yChildren[left]
      const leftP = pChildren[left]
      const rightY = yChildren[yChildCnt - right - 1]
      const rightP = pChildren[pChildCnt - right - 1]
      if (leftY instanceof Y.XmlText && leftP instanceof Array) {
        if (!equalYTextPText(leftY, leftP)) {
          updateYText(leftY, leftP, mapping)
        }
        left += 1
      } else {
        let updateLeft = leftY instanceof Y.XmlElement && matchNodeName(leftY, leftP)
        let updateRight = rightY instanceof Y.XmlElement && matchNodeName(rightY, rightP)
        if (updateLeft && updateRight) {
          // decide which which element to update
          const equalityLeft = computeChildEqualityFactor(/** @type {Y.XmlElement} */ (leftY), /** @type {PModel.Node} */ (leftP), mapping)
          const equalityRight = computeChildEqualityFactor(/** @type {Y.XmlElement} */ (rightY), /** @type {PModel.Node} */ (rightP), mapping)
          if (equalityLeft.foundMappedChild && !equalityRight.foundMappedChild) {
            updateRight = false
          } else if (!equalityLeft.foundMappedChild && equalityRight.foundMappedChild) {
            updateLeft = false
          } else if (equalityLeft.equalityFactor < equalityRight.equalityFactor) {
            updateLeft = false
          } else {
            updateRight = false
          }
        }
        if (updateLeft) {
          updateYFragment(y, /** @type {Y.XmlFragment} */ (leftY), /** @type {PModel.Node} */ (leftP), mapping)
          left += 1
        } else if (updateRight) {
          updateYFragment(y, /** @type {Y.XmlFragment} */ (rightY), /** @type {PModel.Node} */ (rightP), mapping)
          right += 1
        } else {
          yDomFragment.delete(left, 1)
          yDomFragment.insert(left, [createTypeFromTextOrElementNode(leftP, mapping)])
          left += 1
        }
      }
    }
    const yDelLen = yChildCnt - left - right
    if (yDelLen > 0) {
      yDomFragment.delete(left, yDelLen)
    }
    if (left + right < pChildCnt) {
      const ins = []
      for (let i = left; i < pChildCnt - right; i++) {
        ins.push(createTypeFromTextOrElementNode(pChildren[i], mapping))
      }
      yDomFragment.insert(left, ins)
    }
  })
}

/**
 * @function
 * @param {Y.XmlElement} yElement
 * @param {any} pNode Prosemirror Node
 */
const matchNodeName = (yElement, pNode) => yElement.nodeName === pNode.type.name