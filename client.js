// dsh-session-edit — Client half.
//
// 会话内的「编辑」标签页：只显示用户输入、模型思考与回复文字（工具结果不展示），
// 就地编辑、就地保存。没有浮动按钮，也没有弹出编辑窗口。

window.__ModuleLoader__.load({
  id: 'dsh-session-edit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const LABEL = '编辑'
    const VIEW_ID = 'edit-page'

    /** 由 apply 从 Client 服务上抓下来：分叉成功后切到新会话。 */
    let openSession = null

    /**
     * 页面进程内的状态暂存：切走时收下未保存的草稿、展开状态、原文预览和
     * 滚动位置，切回来原样还原，但不写会话、不落盘。刷新、退出应用或
     * 停用插件时随模块一起丢掉。
     */
    const pageStash = new Map()
    let stashEnabled = true

    /** 草稿只收真正改过的；展开、原文预览和滚动落点整份记下。 */
    function stashPageState(context, anchor) {
      if (!stashEnabled || context === null) return
      const { sessionId, data, drafts, callDrafts, expanded, originals } = context
      if (!sessionId) return
      // 快照还没到（切走太快）时无法判断谁改过，保留上一份暂存不动。
      if (!Array.isArray(data?.entries)) return
      const blocks = new Map()
      for (const entry of data.entries) {
        if (entry.role !== 'assistant') continue
        for (const block of entry.blocks) {
          blocks.set(blockKey(entry.seq, block.blockIndex), block)
        }
      }
      const texts = new Map()
      for (const [key, text] of drafts) {
        const block = blocks.get(key)
        if (block !== undefined && block.kind !== 'tool-call' && text !== block.text) texts.set(key, text)
      }
      const calls = new Map()
      for (const [key, draft] of callDrafts) {
        const block = blocks.get(key)
        if (block === undefined || block.kind !== 'tool-call') continue
        if (draft.name !== block.name || draft.arguments !== block.arguments) calls.set(key, draft)
      }
      pageStash.set(sessionId, {
        drafts: texts,
        callDrafts: calls,
        expanded: new Set(expanded),
        originals: new Set(originals),
        anchorSeq: anchor?.seq ?? null,
        anchorOffset: anchor?.offset ?? 0,
      })
    }

    /** 视口顶部第一条仍有内容的条目，作为滚动落点。 */
    function visibleAnchor(data, refs, port) {
      if (port === null || !Array.isArray(data?.entries)) return null
      const portTop = port.getBoundingClientRect().top
      for (const entry of data.entries) {
        const node = refs.get(entry.seq)
        if (node === undefined) continue
        const rect = node.getBoundingClientRect()
        if (rect.bottom > portTop) return { seq: entry.seq, offset: rect.top - portTop }
      }
      return null
    }

    const S = {
      root: {
        height: '100%',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      inner: { maxWidth: '860px', margin: '0 auto', padding: '16px 24px 72px' },
      bar: {
        display: 'flex', alignItems: 'baseline', gap: '10px',
        paddingBottom: '8px', marginBottom: '12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
      },
      title: { fontSize: '13px', fontWeight: 600 },
      hint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' },
      searchAnchor: {
        position: 'sticky', top: '8px', zIndex: 3,
        height: 0, display: 'flex', alignItems: 'flex-start',
        justifyContent: 'flex-end',
        pointerEvents: 'none',
      },
      searchBar: {
        pointerEvents: 'auto',
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: '5px 8px', borderRadius: '8px',
        maxWidth: '100%', boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.96))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        boxShadow: '0 4px 14px rgba(0,0,0,.18)',
        backdropFilter: 'blur(6px)',
      },
      searchInput: {
        width: '220px', minWidth: '80px', flexShrink: 1, boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        borderRadius: '6px', padding: '5px 9px',
        font: 'inherit', fontSize: '12px', outline: 'none',
      },
      searchCount: {
        fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary, #888)',
        minWidth: '40px', textAlign: 'center',
      },
      fieldHit: {
        outline: '2px solid var(--dsw-alias-brand-primary, #247bbf)',
        outlineOffset: '1px',
      },
      spacer: { flex: 1 },
      action: {
        appearance: 'none', border: 'none', background: 'none', padding: '2px 4px',
        color: 'var(--dsw-alias-brand-primary, #247bbf)', cursor: 'pointer',
        font: 'inherit', fontSize: '11px',
      },
      disabledAction: {
        appearance: 'none', border: 'none', background: 'none', padding: '2px 4px',
        color: 'var(--dsw-alias-label-secondary, #888)', cursor: 'default',
        font: 'inherit', fontSize: '11px', opacity: 0.6,
      },
      entry: { padding: '10px 0 12px' },
      entryHead: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' },
      role: { fontSize: '10px', letterSpacing: '.04em', color: 'var(--dsw-alias-label-secondary, #888)' },
      meta: { fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary, #888)' },
      text: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontSize: '13px', lineHeight: 1.55, margin: 0,
        maxHeight: '220px', overflowY: 'auto',
        padding: '7px 10px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05))',
      },
      originalBox: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontSize: '12px', lineHeight: 1.5, margin: '6px 0 0',
        maxHeight: '160px', overflowY: 'auto',
        color: 'var(--dsw-alias-label-secondary, #888)',
        border: '1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        borderRadius: '6px', padding: '6px 9px',
      },
      user: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontSize: '13px', lineHeight: 1.55, margin: 0,
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
        borderRadius: '6px', padding: '7px 10px',
        maxHeight: '160px', overflowY: 'auto',
      },
      reasoning: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontSize: '11.5px', lineHeight: 1.5, margin: '4px 0 0',
        maxHeight: '200px', overflowY: 'auto',
        color: 'var(--dsw-alias-label-secondary, #888)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))',
        borderLeft: '2px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        padding: '6px 9px', borderRadius: '4px',
      },
      block: { marginTop: '8px' },
      blockHead: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '3px' },
      callTag: { fontSize: '10px', letterSpacing: '.04em', color: 'var(--dsw-alias-brand-primary, #247bbf)' },
      callFirst: { marginTop: '4px' },
      callItem: {
        marginTop: '10px', paddingTop: '8px',
        borderTop: '1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
      },
      callLabel: {
        display: 'block', margin: '2px 0 3px', fontSize: '10.5px',
        color: 'var(--dsw-alias-label-secondary, #888)',
      },
      callName: {
        width: '100%', boxSizing: 'border-box', marginBottom: '4px',
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
        borderRadius: '6px', padding: '5px 9px',
        font: 'inherit', fontSize: '12px', outline: 'none',
      },
      resultBox: {
        marginTop: '6px', padding: '6px 9px', borderRadius: '4px',
        borderLeft: '2px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))',
      },
      resultHead: {
        display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '2px',
        fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary, #888)',
      },
      resultText: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontSize: '11.5px', lineHeight: 1.5, margin: 0,
        maxHeight: '160px', overflowY: 'auto',
        color: 'var(--dsw-alias-label-secondary, #888)',
      },
      callNote: {
        marginTop: '6px', fontSize: '10.5px',
        color: 'var(--dsw-alias-label-secondary, #888)',
      },
      toggle: {
        appearance: 'none', border: 'none', background: 'none', padding: 0,
        color: 'var(--dsw-alias-label-secondary, #888)', cursor: 'pointer',
        font: 'inherit', fontSize: '11px',
      },
      thinkToggle: {
        appearance: 'none', border: 'none', background: 'none', padding: 0,
        display: 'flex', alignItems: 'baseline', gap: '5px', minWidth: 0,
        maxWidth: '72%', color: 'var(--dsw-alias-label-secondary, #888)',
        cursor: 'pointer', font: 'inherit', fontSize: '11px', textAlign: 'left',
      },
      thinkPreview: {
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary, #888)', minWidth: 0,
      },
      editor: {
        width: '100%', boxSizing: 'border-box', resize: 'vertical',
        height: '200px', minHeight: '110px', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,.04))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        borderRadius: '6px', padding: '8px 10px',
        font: 'inherit', fontSize: '13px', lineHeight: 1.55,
        outline: 'none',
      },
      editorRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', flexWrap: 'wrap' },
      field: {
        width: '100%', boxSizing: 'border-box', resize: 'vertical',
        height: '150px', minHeight: '80px', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
        borderRadius: '6px', padding: '7px 10px',
        font: 'inherit', fontSize: '13px', lineHeight: 1.55, outline: 'none',
      },
      fieldSmall: {
        width: '100%', boxSizing: 'border-box', resize: 'vertical',
        height: '120px', minHeight: '70px', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))',
        color: 'var(--dsw-alias-label-secondary, #888)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
        borderRadius: '6px', padding: '6px 9px',
        font: 'inherit', fontSize: '11.5px', lineHeight: 1.5, outline: 'none',
      },
      primary: {
        appearance: 'none', cursor: 'pointer', font: 'inherit', fontSize: '11px', fontWeight: 500,
        color: 'var(--dsw-alias-bg-base, #fff)',
        background: 'var(--dsw-alias-brand-primary, #247bbf)',
        border: '1px solid var(--dsw-alias-brand-primary, #247bbf)',
        borderRadius: '6px', padding: '4px 12px',
      },
      primaryOff: {
        appearance: 'none', cursor: 'default', font: 'inherit', fontSize: '11px', fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary, #888)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
        borderRadius: '6px', padding: '4px 12px', opacity: 0.7,
      },
      blockError: {
        color: 'var(--dsw-alias-state-error-primary, #c0392b)', fontSize: '11px',
      },
      secondary: {
        appearance: 'none', cursor: 'pointer', font: 'inherit', fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #888)',
        background: 'none', border: 'none', padding: '4px 6px',
      },
      notice: {
        marginTop: '6px', fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #888)',
      },
      error: {
        marginTop: '6px', fontSize: '11px',
        color: 'var(--dsw-alias-state-error-primary, #c0392b)',
      },
      empty: {
        padding: '40px 0', textAlign: 'center', fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #888)',
      },
      loadEarlier: {
        display: 'flex', justifyContent: 'center',
        padding: '2px 0 10px',
      },
      noticeBar: {
        fontSize: '11px', padding: '6px 10px', marginBottom: '10px',
        borderRadius: '6px', color: 'var(--dsw-alias-label-secondary, #888)',
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))',
      },
    }

    function requestJson(url, init) {
      return fetch(url, init).then(async response => {
        let data = null
        try { data = await response.json() } catch { data = null }
        if (response.ok && data && data.ok === true) return data
        const error = new Error(data?.error || `HTTP ${response.status}`)
        error.code = data?.code || null
        error.actual = data?.actual
        throw error
      })
    }

    function blockKey(seq, blockIndex) {
      return `${seq}:${blockIndex}`
    }

    /**
     * 把各条助手回复摊成可渲染的片段：连续的工具调用跨回复合成一组，
     * 思考、文字和用户消息都会截断这一组。整条回复都被并进前面的组时，
     * 该回复不再单独渲染，锚点指回持有这组的回复。
     */
    function segmentEntries(entries) {
      const segmentsBySeq = new Map()
      const mergedInto = new Map()
      let open = null
      let owner = null
      for (const entry of entries) {
        if (entry.role !== 'assistant') {
          open = null
          owner = null
          continue
        }
        const segments = []
        segmentsBySeq.set(entry.seq, segments)
        for (const block of entry.blocks) {
          if (block.kind !== 'tool-call') {
            open = null
            owner = null
            segments.push({ type: 'block', block })
            continue
          }
          if (open === null) {
            open = { type: 'calls', calls: [] }
            owner = entry.seq
            segments.push(open)
          } else if (owner !== entry.seq) {
            mergedInto.set(entry.seq, owner)
          }
          open.calls.push({ seq: entry.seq, block })
        }
      }
      const anchors = new Map()
      for (const [seq, target] of mergedInto) {
        if ((segmentsBySeq.get(seq)?.length ?? 0) === 0) anchors.set(seq, target)
      }
      return { segmentsBySeq, anchors }
    }

    /** 一次读取/渲染的条目数；滚到顶部再往前补一页。 */
    const WINDOW = 30
    /** 刷新时最多往回调几页，避免异常分页把整段历史拉回来。 */
    const MAX_WINDOWS = 20

    /** 编辑页通常不是滚动容器：找真正带 overflow 的祖先（会话的滚轮体）。 */
    function scrollPortOf(node) {
      if (node === null) return null
      const scrollable = element => {
        const overflow = getComputedStyle(element).overflowY
        return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay'
      }
      if (scrollable(node) && node.scrollHeight > node.clientHeight) return node
      let cursor = node.parentElement
      while (cursor !== null) {
        if (scrollable(cursor)) return cursor
        cursor = cursor.parentElement
      }
      return null
    }

    /** 末尾回复：优先最后一条助手回复，没有就用最后一条。 */
    function lastReplySeq(entries) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index].role === 'assistant') return entries[index].seq
      }
      return entries.length > 0 ? entries[entries.length - 1].seq : null
    }

    /** 折叠时只露一行：取第一段非空文本。 */
    function previewLine(text) {
      const line = String(text ?? '').split('\n').find(item => item.trim() !== '')
      return line === undefined ? '（空）' : line.trim()
    }

    /** 参数必须是 JSON 对象；合法返回 null，否则返回错误文案。 */
    function argumentsError(raw) {
      let value
      try { value = JSON.parse(raw) } catch { return '参数不是合法 JSON' }
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? null
        : '参数必须是 JSON 对象'
    }

    function Entry(props) {
      const {
        entry, segments, expanded, onToggle, busy, locked, originals, onToggleOriginal, onRestore,
        onFork, confirmFork, drafts, onDraft, onSaveBlock, callDrafts, onCallDraft, onSaveCall,
        errors, entryRef, canJump, onJump, registerField, highlightKey,
      } = props

      if (entry.role === 'user') {
        return h('div', { ref: entryRef, style: S.entry, 'data-edit-page': 'user' },
          h('div', { style: S.entryHead },
            h('span', { style: S.role }, '你'),
            h('span', { style: S.meta }, `#${entry.seq}`),
            h('span', { style: S.spacer }),
            canJump ? h('button', { type: 'button', style: S.action, onClick: onJump }, '跳到回复 ↓') : null,
          ),
          h('div', { style: S.user }, entry.text),
        )
      }

      const renderCall = (call, separated) => {
        const { seq, block } = call
        const key = blockKey(seq, block.blockIndex)
        const error = errors.get(key)
        const draft = callDrafts.get(key) ?? { name: block.name, arguments: block.arguments }
        const dirty = draft.name !== block.name || draft.arguments !== block.arguments
        const label = draft.name.trim() === '' ? '（空名）' : draft.name.trim()
        const row = h('div', { style: S.editorRow },
          h('button', {
            type: 'button',
            style: !dirty || busy || locked ? S.primaryOff : S.primary,
            disabled: !dirty || busy || locked,
            onClick: () => onSaveCall(seq, block, draft),
          }, '保存'),
          block.patched
            ? h('button', {
              type: 'button', style: S.secondary, disabled: busy || locked,
              onClick: () => onToggleOriginal(key),
            }, originals.has(key) ? '收起原文' : '原文')
            : null,
          block.patched
            ? h('button', {
              type: 'button', style: S.secondary, disabled: busy || locked,
              onClick: () => onRestore(seq, block),
            }, '还原')
            : null,
          dirty ? h('span', { style: S.meta }, '未保存') : null,
          error ? h('span', { style: S.blockError }, error) : null,
        )
        return h('div', { key, style: separated ? S.callItem : S.callFirst },
          h('div', { style: S.blockHead },
            h('span', { style: S.callTag }, label),
            dirty
              ? h('span', { style: S.meta }, '未保存')
              : block.patched ? h('span', { style: S.meta }, '已改') : null,
            h('span', { style: S.spacer }),
          ),
          h('span', { style: S.callLabel }, '名字'),
          h('input', {
            style: S.callName,
            value: draft.name,
            spellCheck: false,
            disabled: locked,
            'aria-label': '工具名',
            onChange: event => onCallDraft(key, draft, { name: event.target.value }),
          }),
          h('span', { style: S.callLabel }, '参数（JSON 对象）'),
          h('textarea', {
            style: S.fieldSmall,
            value: draft.arguments,
            spellCheck: false,
            disabled: locked,
            'aria-label': '工具参数',
            onChange: event => onCallDraft(key, draft, { arguments: event.target.value }),
            onKeyDown: event => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                if (dirty && !busy && !locked) onSaveCall(entry.seq, block, draft)
              }
            },
          }),
          row,
          block.result
            ? h('div', { style: S.resultBox },
              h('div', { style: S.resultHead },
                h('span', null, '结果'),
                h('span', { style: S.meta }, `#${block.result.seq}`),
                block.result.isError ? h('span', { style: S.blockError }, '失败') : null,
                block.result.truncated ? h('span', { style: S.meta }, '已截断') : null,
              ),
              h('div', { style: S.resultText }, block.result.text === '' ? '（空结果）' : block.result.text),
            )
            : h('div', { style: S.callNote }, '没有配对的结果'),
          block.patched && originals.has(key)
            ? h('div', { style: S.originalBox }, `${block.original.name}\n${block.original.arguments}`)
            : null,
        )
      }

      // 连续的工具调用共用一个折叠层：默认收起，展开后每条直接可改。
      const renderGroup = calls => {
        const groupKey = `${calls[0].seq}:g${calls[0].block.blockIndex}`
        const open = expanded.has(groupKey)
        const names = []
        let dirty = 0
        let patched = 0
        for (const call of calls) {
          const key = blockKey(call.seq, call.block.blockIndex)
          const draft = callDrafts.get(key) ?? { name: call.block.name, arguments: call.block.arguments }
          if (draft.name !== call.block.name || draft.arguments !== call.block.arguments) dirty += 1
          if (call.block.patched) patched += 1
          names.push(draft.name.trim() === '' ? '（空名）' : draft.name.trim())
        }
        return h('div', { key: groupKey, style: S.block },
          h('div', { style: S.blockHead },
            h('button', {
              type: 'button',
              style: S.thinkToggle,
              onClick: () => onToggle(groupKey),
              title: open ? '收起工具调用' : '展开工具调用',
            },
              h('span', null, open ? '▾' : '▸'),
              h('span', null, '工具调用'),
              h('span', { style: open ? S.meta : S.thinkPreview }, open
                ? `· ${calls.length} 条`
                : `· ${calls.length} 条 · ${[...new Set(names)].join('、')}`),
            ),
            h('span', { style: S.spacer }),
            dirty > 0
              ? h('span', { style: S.meta }, `未保存 ${dirty}`)
              : patched > 0 ? h('span', { style: S.meta }, `已改 ${patched}`) : null,
          ),
          open
            ? h('div', null,
              calls.map((call, index) => renderCall(call, index > 0)),
              h('div', { style: S.editorRow },
                h('button', {
                  type: 'button', style: S.secondary, disabled: busy,
                  onClick: () => onToggle(groupKey),
                }, '收起工具调用'),
              ),
            )
            : null,
        )
      }

      const renderText = block => {
        const key = blockKey(entry.seq, block.blockIndex)
        const error = errors.get(key)
        const draft = drafts.get(key) ?? block.text
        const dirty = draft !== block.text
        const row = h('div', { style: S.editorRow },
          h('button', {
            type: 'button',
            style: !dirty || busy || locked ? S.primaryOff : S.primary,
            disabled: !dirty || busy || locked,
            onClick: () => onSaveBlock(entry.seq, block, draft),
          }, '保存'),
          block.patched
            ? h('button', {
              type: 'button', style: S.secondary, disabled: busy || locked,
              onClick: () => onToggleOriginal(key),
            }, originals.has(key) ? '收起原文' : '原文')
            : null,
          block.patched
            ? h('button', {
              type: 'button', style: S.secondary, disabled: busy || locked,
              onClick: () => onRestore(entry.seq, block),
            }, '还原')
            : null,
          dirty ? h('span', { style: S.meta }, '未保存') : null,
          error ? h('span', { style: S.blockError }, error) : null,
        )
        const fieldStyle = block.kind === 'reasoning' ? S.fieldSmall : S.field
        const field = h('textarea', {
          ref: node => registerField(key, node),
          style: key === highlightKey ? { ...fieldStyle, ...S.fieldHit } : fieldStyle,
          value: draft,
          spellCheck: false,
          disabled: locked,
          'aria-label': block.kind === 'reasoning' ? '思考文本' : '回复文本',
          onChange: event => onDraft(key, event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              if (dirty && !busy && !locked) onSaveBlock(entry.seq, block, draft)
            }
          },
        })

        if (block.kind === 'reasoning') {
          const open = expanded.has(key)
          return h('div', { key, style: S.block },
            h('div', { style: S.blockHead },
              h('button', {
                type: 'button',
                style: S.thinkToggle,
                onClick: () => onToggle(key),
                title: open ? '收起思考' : '展开思考',
              },
                h('span', null, open ? '▾' : '▸'),
                h('span', null, '思考'),
                h('span', { style: open ? S.meta : S.thinkPreview }, open ? `· ${draft.length} 字` : previewLine(draft)),
              ),
              h('span', { style: S.spacer }),
              block.patched ? h('span', { style: S.meta }, '已改') : null,
            ),
            open
              ? h('div', null,
                field,
                row,
                block.patched && originals.has(key) ? h('div', { style: S.originalBox }, block.original) : null,
              )
              : null,
          )
        }

        return h('div', { key, style: S.block },
          h('div', { style: S.blockHead },
            block.patched ? h('span', { style: S.meta }, '已改') : null,
            h('span', { style: S.spacer }),
          ),
          field,
          row,
          block.patched && originals.has(key) ? h('div', { style: S.originalBox }, block.original) : null,
        )
      }

      const blocks = segments.map(segment => (
        segment.type === 'calls' ? renderGroup(segment.calls) : renderText(segment.block)
      ))

      return h('div', { ref: entryRef, style: S.entry, 'data-edit-page': 'assistant' },
        locked || !onFork
          ? null
          : h('div', { style: S.entryHead },
            h('span', { style: S.spacer }),
            h('button', {
              type: 'button',
              style: S.action,
              onClick: () => onFork(entry.seq),
              title: '以这条回复为最新一轮，分叉出新会话继续',
            }, confirmFork === entry.seq ? '再点一次确认' : '分叉'),
          ),
        h('div', null, blocks),
      )
    }

    function EditPage(props) {
      const sessionId = props?.sessionId
      const stashed = sessionId ? pageStash.get(sessionId) : undefined
      const [data, setData] = useState(null)
      const [status, setStatus] = useState('loading')
      const [failure, setFailure] = useState(null)
      const [expanded, setExpanded] = useState(() => new Set(stashed?.expanded ?? []))
      const [originals, setOriginals] = useState(() => new Set(stashed?.originals ?? []))
      const [busy, setBusy] = useState(false)
      const [loadingEarlier, setLoadingEarlier] = useState(false)
      const [notice, setNotice] = useState(null)
      const [entryError, setEntryError] = useState(null)
      const [drafts, setDrafts] = useState(() => new Map(stashed?.drafts ?? []))
      const [callDrafts, setCallDrafts] = useState(() => new Map(stashed?.callDrafts ?? []))
      const [blockErrors, setBlockErrors] = useState(() => new Map())
      const [pendingStart, setPendingStart] = useState(null)
      const [confirmFork, setConfirmFork] = useState(null)
      const [searchOpen, setSearchOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [matchIndex, setMatchIndex] = useState(0)
      const [highlightKey, setHighlightKey] = useState(null)
      const [pendingJump, setPendingJump] = useState(null)
      const rootRef = useRef(null)
      const scrollPortRef = useRef(null)
      const fieldRefs = useRef(new Map())
      const searchInputRef = useRef(null)
      const refs = useRef(new Map())
      const alive = useRef(true)
      const scrolled = useRef(false)
      const confirmTimer = useRef(null)
      const restoreRef = useRef(stashed
        ? { seq: stashed.anchorSeq ?? null, offset: stashed.anchorOffset ?? 0 }
        : null)
      const anchorRef = useRef(stashed
        ? { seq: stashed.anchorSeq ?? null, offset: stashed.anchorOffset ?? 0 }
        : null)
      const pendingRestoreRef = useRef(null)
      const entriesRef = useRef([])
      entriesRef.current = data?.entries ?? []
      const sessionRef = useRef(sessionId)
      // 只在 state 与 sessionId 同属一个会话时更新，避免切会话的一帧里把旧状态记到新会话。
      const stashRef = useRef(null)
      if (sessionRef.current === sessionId) {
        stashRef.current = { sessionId, data, drafts, callDrafts, expanded, originals }
      }

      const captureAnchor = useCallback(() => {
        const anchor = visibleAnchor(stashRef.current?.data, refs.current, scrollPortRef.current)
        if (anchor !== null) anchorRef.current = anchor
      }, [])

      // 检索可编辑的回复与思考（含未保存草稿）；大小写不敏感，最多 500 条。
      const matches = useMemo(() => {
        if (data === null || query === '') return []
        const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
        const found = []
        for (const entry of data.entries) {
          if (entry.role !== 'assistant') continue
          for (const block of entry.blocks) {
            if (block.kind !== 'text' && block.kind !== 'reasoning') continue
            const key = blockKey(entry.seq, block.blockIndex)
            const text = drafts.get(key) ?? block.text
            pattern.lastIndex = 0
            let hit
            while ((hit = pattern.exec(text)) !== null) {
              found.push({
                key,
                seq: entry.seq,
                blockIndex: block.blockIndex,
                kind: block.kind,
                start: hit.index,
                length: hit[0].length,
              })
              if (found.length >= 500) return found
              if (hit[0].length === 0) pattern.lastIndex += 1
            }
          }
        }
        return found
      }, [data, drafts, query])

      const currentMatch = matches.length === 0
        ? null
        : matches[Math.min(matchIndex, matches.length - 1)]

      const registerField = useCallback((key, node) => {
        if (node === null) fieldRefs.current.delete(key)
        else fieldRefs.current.set(key, node)
      }, [])

      const openSearch = useCallback(() => {
        setSearchOpen(true)
        requestAnimationFrame(() => {
          const input = searchInputRef.current
          if (input !== null) {
            input.focus()
            input.select()
          }
        })
      }, [])

      /** 跳到一条命中：折叠的思考先展开，滚过去并选中文本。 */
      const jumpTo = useCallback(match => {
        if (match === null) return
        if (match.kind === 'reasoning') {
          setExpanded(current => (current.has(match.key) ? current : new Set(current).add(match.key)))
        }
        setPendingJump(match)
      }, [])

      const stepMatch = useCallback(delta => {
        if (matches.length === 0) return
        const at = (Math.min(matchIndex, matches.length - 1) + delta + matches.length) % matches.length
        setMatchIndex(at)
        jumpTo(matches[at])
      }, [jumpTo, matchIndex, matches])

      useEffect(() => {
        const port = scrollPortOf(rootRef.current)
        scrollPortRef.current = port
        if (port === null) return undefined
        let frame = 0
        const onScroll = () => {
          if (frame !== 0) return
          frame = requestAnimationFrame(() => {
            frame = 0
            captureAnchor()
          })
        }
        port.addEventListener('scroll', onScroll, { passive: true })
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          port.removeEventListener('scroll', onScroll)
        }
      }, [captureAnchor])

      // 布局变化后重算「视口顶部那条」，切走时只读 ref，不再碰已卸载的 DOM。
      useEffect(() => {
        const frame = requestAnimationFrame(captureAnchor)
        return () => cancelAnimationFrame(frame)
      }, [captureAnchor, data, expanded, originals, status, searchOpen])

      useEffect(() => () => {
        alive.current = false
        if (confirmTimer.current) clearTimeout(confirmTimer.current)
        stashPageState(stashRef.current, anchorRef.current)
      }, [])

      const load = useCallback(async (quiet) => {
        if (!sessionId) return
        if (!quiet) setStatus(current => (current === 'ready' ? 'ready' : 'loading'))
        const restore = restoreRef.current
        const keepAnchor = scrolled.current ? anchorRef.current : null
        const currentFirst = entriesRef.current[0]?.seq ?? null
        const anchor = restore !== null ? restore.seq : currentFirst
        try {
          const tail = await requestJson(`/api/edit-page/v1/session?sessionId=${encodeURIComponent(sessionId)}&limit=${WINDOW}`)
          let entries = tail.entries
          let hasMore = tail.hasMore === true
          let windows = 0
          // 回到离开时的窗口范围：只补前面缺的那几页，不重读整段历史。
          while (hasMore && anchor !== null && entries.length > 0 && entries[0].seq > anchor && windows < MAX_WINDOWS) {
            let earlier
            try {
              earlier = await requestJson(`/api/edit-page/v1/session?sessionId=${encodeURIComponent(sessionId)}&limit=${WINDOW}&before=${entries[0].seq}`)
            } catch (error) {
              // 锚点被压缩/替换掉时退回末尾窗口，不把整页卡在错误上。
              if (error.code === 'WINDOW_STALE') break
              throw error
            }
            entries = [...earlier.entries, ...entries]
            hasMore = earlier.hasMore === true
            windows += 1
          }
          if (!alive.current) return
          restoreRef.current = null
          setData({ ...tail, entries, hasMore })
          setFailure(null)
          setStatus('ready')
          const reached = restore !== null && anchor !== null
            && entries.some(entry => entry.seq === anchor)
          if (reached) {
            pendingRestoreRef.current = { seq: anchor, offset: restore.offset }
            scrolled.current = true
          } else if (!scrolled.current && entries.length > 0) {
            // 首次进入落到末尾回复的开头；之后刷新不再跳。
            scrolled.current = true
            setPendingStart(lastReplySeq(entries))
          } else if (keepAnchor !== null && anchorRef.current?.seq === keepAnchor.seq
            && entries.some(entry => entry.seq === keepAnchor.seq)) {
            // 刷新/保存后的重读：用户没动过就停在原来那条上。
            pendingRestoreRef.current = keepAnchor
          }
        } catch (error) {
          if (!alive.current) return
          if (!error.code && /fetch|network/i.test(String(error.message))) {
            error.message = '编辑服务不可用：插件可能已停用'
          }
          setFailure(error)
          setStatus('error')
        }
      }, [sessionId])

      const loadEarlier = useCallback(async () => {
        if (busy || loadingEarlier) return
        const currentFirst = entriesRef.current[0]?.seq
        if (currentFirst === undefined) return
        setLoadingEarlier(true)
        try {
          const earlier = await requestJson(`/api/edit-page/v1/session?sessionId=${encodeURIComponent(sessionId)}&limit=${WINDOW}&before=${currentFirst}`)
          if (!alive.current) return
          setData(current => {
            if (current === null) return current
            const known = new Set(current.entries.map(entry => entry.seq))
            const fresh = earlier.entries.filter(entry => !known.has(entry.seq))
            return {
              ...current,
              entries: [...fresh, ...current.entries],
              hasMore: earlier.hasMore === true,
            }
          })
        } catch (error) {
          if (!alive.current) return
          if (error.code === 'WINDOW_STALE') await load(false)
          else setEntryError(error.message)
        } finally {
          if (alive.current) setLoadingEarlier(false)
        }
      }, [busy, loadingEarlier, load, sessionId])

      useEffect(() => {
        if (sessionRef.current !== sessionId) {
          stashPageState(stashRef.current, anchorRef.current)
          sessionRef.current = sessionId
          const next = sessionId ? pageStash.get(sessionId) : undefined
          setDrafts(new Map(next?.drafts ?? []))
          setCallDrafts(new Map(next?.callDrafts ?? []))
          setExpanded(new Set(next?.expanded ?? []))
          setOriginals(new Set(next?.originals ?? []))
          restoreRef.current = next
            ? { seq: next.anchorSeq ?? null, offset: next.anchorOffset ?? 0 }
            : null
          anchorRef.current = restoreRef.current
          pendingRestoreRef.current = null
          scrolled.current = false
          setPendingStart(null)
        }
        setData(null)
        setNotice(null)
        setEntryError(null)
        setBlockErrors(new Map())
        setConfirmFork(null)
        load(false)
      }, [sessionId, load])

      // 默认就是编辑态：为每个可编辑块准备一份草稿，已存在的不覆盖（避免冲掉未保存输入）。
      useEffect(() => {
        if (!data) return
        setDrafts(current => {
          let changed = false
          const next = new Map(current)
          for (const entry of data.entries) {
            if (entry.role !== 'assistant') continue
            for (const block of entry.blocks) {
              if (block.kind === 'tool-call') continue
              const key = blockKey(entry.seq, block.blockIndex)
              if (next.has(key)) continue
              next.set(key, block.text)
              changed = true
            }
          }
          return changed ? next : current
        })
        setCallDrafts(current => {
          let changed = false
          const next = new Map(current)
          for (const entry of data.entries) {
            if (entry.role !== 'assistant') continue
            for (const block of entry.blocks) {
              if (block.kind !== 'tool-call') continue
              const key = blockKey(entry.seq, block.blockIndex)
              if (next.has(key)) continue
              next.set(key, { name: block.name, arguments: block.arguments })
              changed = true
            }
          }
          return changed ? next : current
        })
      }, [data])

      // 首次进入：把末尾回复的开头对齐到视口顶部，而不是从页首或页尾开始。
      useEffect(() => {
        if (pendingStart === null || data === null) return
        const node = refs.current.get(anchors.get(pendingStart) ?? pendingStart)
        if (node && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'start' })
        }
        setPendingStart(null)
      }, [pendingStart, data])

      // 数据到齐后把暂存时视口顶部的那条对齐回顶部，再补回它当时的偏移。
      useEffect(() => {
        if (status !== 'ready' || data === null) return
        const target = pendingRestoreRef.current
        if (target === null) return
        pendingRestoreRef.current = null
        const node = refs.current.get(anchors.get(target.seq) ?? target.seq)
        if (node === undefined) {
          setPendingStart(lastReplySeq(entries))
          return
        }
        if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
        const port = scrollPortRef.current
        if (port !== null) port.scrollTop -= target.offset
        anchorRef.current = target
      }, [status, data])

      useEffect(() => {
        const onFocus = () => { if (!busy) load(true) }
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [busy, load])

      // 输入变化回到第一条命中。
      useEffect(() => {
        setMatchIndex(0)
      }, [query])

      // 高亮当前命中并滚到它；不抢输入框焦点，打字不会断。
      useEffect(() => {
        if (currentMatch === null) {
          setHighlightKey(null)
          return undefined
        }
        setHighlightKey(currentMatch.key)
        const timer = setTimeout(() => {
          // 只有还在检索框里打字时才自动滚；跳进编辑框后就别抢滚动。
          if (document.activeElement !== searchInputRef.current) return
          const node = fieldRefs.current.get(currentMatch.key)
          if (node !== undefined) node.scrollIntoView({ block: 'center' })
        }, 120)
        return () => clearTimeout(timer)
      }, [currentMatch?.key, currentMatch?.start])

      // 显式跳转：滚到这条并选中命中文本，焦点交给编辑框。
      useEffect(() => {
        if (pendingJump === null) return
        const node = fieldRefs.current.get(pendingJump.key)
        if (node === undefined) return
        setPendingJump(null)
        node.scrollIntoView({ block: 'center' })
        if (node.disabled) return
        node.focus()
        node.setSelectionRange(pendingJump.start, pendingJump.start + pendingJump.length)
      }, [pendingJump, data, expanded])

      useEffect(() => {
        if (searchOpen) return
        setHighlightKey(null)
      }, [searchOpen])

      // Ctrl+F 开检索，F3 / Shift+F3 上下跳，Esc 关闭。
      useEffect(() => {
        const onKeyDown = event => {
          if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
            && event.key.toLowerCase() === 'f') {
            event.preventDefault()
            openSearch()
            return
          }
          if (event.key === 'F3' && searchOpen) {
            event.preventDefault()
            stepMatch(event.shiftKey ? -1 : 1)
            return
          }
          if (event.key === 'Escape' && searchOpen) {
            event.preventDefault()
            setSearchOpen(false)
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [openSearch, searchOpen, stepMatch])

      const toggle = key => {
        setExpanded(current => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      const toggleOriginal = key => {
        setOriginals(current => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      const setDraft = (key, value) => {
        setDrafts(current => {
          const next = new Map(current)
          next.set(key, value)
          return next
        })
        setBlockErrors(current => {
          if (!current.has(key)) return current
          const next = new Map(current)
          next.delete(key)
          return next
        })
      }

      const setCallDraft = (key, draft, patch) => {
        setCallDrafts(current => {
          const next = new Map(current)
          next.set(key, { ...draft, ...patch })
          return next
        })
        setBlockErrors(current => {
          if (!current.has(key)) return current
          const next = new Map(current)
          next.delete(key)
          return next
        })
      }

      const saveBlock = async (seq, block, text) => {
        if (busy) return
        const key = blockKey(seq, block.blockIndex)
        setBusy(true)
        setNotice(null)
        try {
          const result = await requestJson('/api/edit-page/v1/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-edit-page': '1' },
            body: JSON.stringify({
              sessionId,
              seq,
              blockIndex: block.blockIndex,
              kind: block.kind,
              text,
              expectText: block.text,
            }),
          })
          setDrafts(current => {
            const next = new Map(current)
            next.set(key, result.text)
            return next
          })
          setNotice(`#${seq} 已保存，模型下一轮看到的就是改后的内容`)
          await load(true)
        } catch (error) {
          setBlockErrors(current => new Map(current).set(key, error.message))
          if (error.code === 'STALE_TARGET') await load(true)
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const saveCall = async (seq, block, draft) => {
        if (busy) return
        const key = blockKey(seq, block.blockIndex)
        const name = draft.name.trim()
        const invalid = name === ''
          ? '工具名不能为空'
          : argumentsError(draft.arguments)
        if (invalid !== null) {
          setBlockErrors(current => new Map(current).set(key, invalid))
          return
        }
        setBusy(true)
        setNotice(null)
        try {
          const result = await requestJson('/api/edit-page/v1/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-edit-page': '1' },
            body: JSON.stringify({
              sessionId,
              seq,
              blockIndex: block.blockIndex,
              kind: 'tool-call',
              name,
              arguments: draft.arguments,
              expectName: block.name,
              expectArguments: block.arguments,
            }),
          })
          setCallDrafts(current => {
            const next = new Map(current)
            next.set(key, { name: result.name, arguments: result.arguments })
            return next
          })
          setNotice(`#${seq} 工具调用已保存，模型下一轮看到的就是改后的调用`)
          await load(true)
        } catch (error) {
          setBlockErrors(current => new Map(current).set(key, error.message))
          if (error.code === 'STALE_TARGET') await load(true)
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const restore = async (seq, block) => {
        if (busy || block.original === undefined) return
        const key = blockKey(seq, block.blockIndex)
        setBusy(true)
        try {
          const payload = block.kind === 'tool-call'
            ? {
              sessionId,
              seq,
              blockIndex: block.blockIndex,
              kind: block.kind,
              name: block.original.name,
              arguments: block.original.arguments,
              expectName: block.name,
              expectArguments: block.arguments,
            }
            : {
              sessionId,
              seq,
              blockIndex: block.blockIndex,
              kind: block.kind,
              text: block.original,
              expectText: block.text,
            }
          await requestJson('/api/edit-page/v1/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-edit-page': '1' },
            body: JSON.stringify(payload),
          })
          if (block.kind === 'tool-call') {
            setCallDrafts(current => {
              const next = new Map(current)
              next.set(key, block.original)
              return next
            })
          } else {
            setDrafts(current => {
              const next = new Map(current)
              next.set(key, block.original)
              return next
            })
          }
          setBlockErrors(current => {
            if (!current.has(key)) return current
            const next = new Map(current)
            next.delete(key)
            return next
          })
          setNotice('已还原为原文')
          await load(true)
        } catch (error) {
          setBlockErrors(current => new Map(current).set(key, error.message))
          if (error.code === 'STALE_TARGET') await load(true)
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const requestFork = seq => {
        if (busy) return
        if (confirmFork !== seq) {
          setConfirmFork(seq)
          if (confirmTimer.current) clearTimeout(confirmTimer.current)
          confirmTimer.current = setTimeout(() => setConfirmFork(null), 4000)
          return
        }
        setConfirmFork(null)
        if (confirmTimer.current) clearTimeout(confirmTimer.current)
        forkFrom(seq)
      }

      const forkFrom = async seq => {
        if (busy) return
        setBusy(true)
        setEntryError(null)
        setNotice(null)
        try {
          const result = await requestJson('/api/edit-page/v1/fork', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-edit-page': '1' },
            body: JSON.stringify({ sessionId, seq }),
          })
          const extra = result.copied > 0 ? `，带入 ${result.copied} 处改稿` : ''
          setNotice(`已从 #${seq} 分叉：${result.sessionId}${extra}`)
          if (openSession) {
            try { openSession(result.sessionId) } catch { /* 导航失败时留在本页，提示里带编号 */ }
          }
        } catch (error) {
          setEntryError(error.message)
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const jump = seq => {
        const node = refs.current.get(anchors.get(seq) ?? seq)
        if (node && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'start', behavior: 'smooth' })
        }
      }

      const entries = data?.entries ?? []
      const { segmentsBySeq, anchors } = segmentEntries(entries)
      const locked = status === 'ready' && Boolean(data?.running)
      const lastAssistant = [...entries].reverse().find(entry => entry.role === 'assistant')

      const jumpTarget = index => {
        for (let cursor = index + 1; cursor < entries.length; cursor += 1) {
          if (entries[cursor].role === 'assistant') return entries[cursor].seq
        }
        return null
      }

      return h('div', {
        ref: rootRef,
        style: S.root,
        'data-edit-page': 'root',
      },
        h('div', { style: S.inner },
          h('div', { style: S.bar },
            h('span', { style: S.title }, LABEL),
            h('span', { style: S.hint }, '文字与思考可改，工具调用可改、结果只读'),
            h('span', { style: S.spacer }),
            entries.length > 0 ? h('span', { style: S.meta }, `已载入 ${entries.length} 条`) : null,
            data?.running ? h('span', { style: { ...S.meta, color: 'var(--dsw-alias-state-warn-primary, #b8860b)' } }, '运行中') : null,
            h('button', {
              type: 'button', style: S.action,
              onClick: () => (searchOpen ? setSearchOpen(false) : openSearch()),
            }, '检索'),
            h('button', { type: 'button', style: S.action, onClick: () => load(false) }, '刷新'),
            lastAssistant ? h('button', { type: 'button', style: S.action, onClick: () => jump(lastAssistant.seq) }, '最新 ↓') : null,
          ),

          searchOpen
            ? h('div', { style: S.searchAnchor },
              h('div', { style: S.searchBar },
                h('input', {
                  ref: searchInputRef,
                  style: S.searchInput,
                  value: query,
                  placeholder: '检索文字与思考（Enter 跳到当前，F3 下一个）',
                  spellCheck: false,
                  'aria-label': '检索',
                  onChange: event => setQuery(event.target.value),
                  onKeyDown: event => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    if (event.shiftKey) stepMatch(-1)
                    else jumpTo(currentMatch)
                  },
                }),
                h('span', { style: S.searchCount }, query === ''
                  ? ''
                  : matches.length === 0
                    ? '无匹配'
                    : `${Math.min(matchIndex, matches.length - 1) + 1}/${matches.length}`),
                h('button', {
                  type: 'button', style: S.action, disabled: matches.length === 0,
                  onClick: () => stepMatch(-1), title: '上一个匹配（Shift+F3）',
                }, '上一个'),
                h('button', {
                  type: 'button', style: S.action, disabled: matches.length === 0,
                  onClick: () => stepMatch(1), title: '下一个匹配（F3）',
                }, '下一个'),
                h('button', { type: 'button', style: S.action, onClick: () => setSearchOpen(false) }, '关闭'),
              ),
            )
            : null,

          status === 'loading' ? h('div', { style: S.empty }, '载入中…') : null,
          status === 'error'
            ? h('div', { style: S.error }, failure?.code === 'SESSION_NOT_LIVE'
              ? '会话未载入，切回对话再进入这个分页。'
              : `读取失败：${failure?.message ?? '未知错误'}`)
            : null,
          status === 'ready' && entries.length === 0
            ? h('div', { style: S.empty }, '这个会话还没有可编辑的文字。')
            : null,
          status === 'ready' && data?.active === false
            ? h('div', { style: S.noticeBar }, '编辑插件已停用：下面的内容是原文，重新启用后才会应用改稿。')
            : null,
          locked
            ? h('div', { style: S.noticeBar }, '模型正在运行，这一轮结束后才能保存修改。')
            : null,
          status === 'ready' && data?.hasMore === true
            ? h('div', { style: S.loadEarlier },
              h('button', {
                type: 'button', style: S.action, disabled: loadingEarlier || busy,
                onClick: loadEarlier,
              }, loadingEarlier ? '载入更早…' : '↑ 加载更早的对话'))
            : null,

          entries.map((entry, index) => {
            if (entry.role === 'assistant' && segmentsBySeq.get(entry.seq).length === 0) return null
            const target = entry.role === 'user' ? jumpTarget(index) : null
            return h(Entry, {
              key: `${entry.role}:${entry.seq}`,
              entry,
              segments: entry.role === 'assistant' ? segmentsBySeq.get(entry.seq) : undefined,
              entryRef: node => {
                if (node) refs.current.set(entry.seq, node)
                else refs.current.delete(entry.seq)
              },
              expanded,
              onToggle: toggle,
              originals,
              onToggleOriginal: toggleOriginal,
              onRestore: restore,
              drafts,
              onDraft: setDraft,
              onSaveBlock: saveBlock,
              registerField,
              highlightKey,
              callDrafts,
              onCallDraft: setCallDraft,
              onSaveCall: saveCall,
              errors: blockErrors,
              busy,
              locked,
              onFork: requestFork,
              confirmFork,
              onJump: () => target !== null && jump(target),
              canJump: target !== null,
            })
          }),

          status === 'ready' && notice !== null
            ? h('div', { style: S.notice }, notice)
            : null,
          status === 'ready' && entryError !== null
            ? h('div', { style: S.error }, entryError)
            : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        stashEnabled = true
        ctx.effect(() => () => {
          stashEnabled = false
          pageStash.clear()
        }, 'session-edit: page stash')
        try {
          openSession = typeof ctx.uiWorkspace?.openSession === 'function'
            ? ctx.uiWorkspace.openSession.bind(ctx.uiWorkspace)
            : null
        } catch {
          openSession = null
        }
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: VIEW_ID,
          order: 20,
          label: LABEL,
        }, EditPage))
      },
    }
  },
})
