// dsh-session-edit — Client half.
//
// 会话内的「编辑」标签页：只显示用户输入、模型思考与回复文字（工具结果不展示），
// 就地编辑、就地保存。没有浮动按钮，也没有弹出编辑窗口。

window.__ModuleLoader__.load({
  id: 'dsh-session-edit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const LABEL = '编辑'
    const VIEW_ID = 'edit-page'

    /** 由 apply 从 Client 服务上抓下来：分叉成功后切到新会话。 */
    let openSession = null

    const S = {
      root: {
        height: '100%',
        overflowY: 'auto',
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
        errors, entryRef, canJump, onJump,
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
        const field = h('textarea', {
          style: block.kind === 'reasoning' ? S.fieldSmall : S.field,
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
      const [data, setData] = useState(null)
      const [status, setStatus] = useState('loading')
      const [failure, setFailure] = useState(null)
      const [expanded, setExpanded] = useState(() => new Set())
      const [originals, setOriginals] = useState(() => new Set())
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [entryError, setEntryError] = useState(null)
      const [drafts, setDrafts] = useState(() => new Map())
      const [callDrafts, setCallDrafts] = useState(() => new Map())
      const [blockErrors, setBlockErrors] = useState(() => new Map())
      const [pendingScroll, setPendingScroll] = useState(null)
      const [confirmFork, setConfirmFork] = useState(null)
      const refs = useRef(new Map())
      const alive = useRef(true)
      const scrolled = useRef(false)
      const confirmTimer = useRef(null)

      useEffect(() => () => {
        alive.current = false
        if (confirmTimer.current) clearTimeout(confirmTimer.current)
      }, [])

      const load = useCallback(async (quiet) => {
        if (!sessionId) return
        if (!quiet) setStatus(current => (current === 'ready' ? 'ready' : 'loading'))
        try {
          const next = await requestJson(`/api/edit-page/v1/session?sessionId=${encodeURIComponent(sessionId)}`)
          if (!alive.current) return
          setData(next)
          setFailure(null)
          setStatus('ready')
          // 首次载入直接落到最新一条：编辑页不从头开始看。
          if (!scrolled.current && next.entries.length > 0) {
            scrolled.current = true
            const lastSeq = next.entries[next.entries.length - 1].seq
            setPendingScroll(segmentEntries(next.entries).anchors.get(lastSeq) ?? lastSeq)
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

      useEffect(() => {
        setData(null)
        setNotice(null)
        setEntryError(null)
        setExpanded(new Set())
        setOriginals(new Set())
        setDrafts(new Map())
        setCallDrafts(new Map())
        setBlockErrors(new Map())
        setPendingScroll(null)
        setConfirmFork(null)
        scrolled.current = false
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

      useEffect(() => {
        if (pendingScroll === null) return
        const node = refs.current.get(pendingScroll)
        if (node && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'end' })
        }
        setPendingScroll(null)
      }, [pendingScroll, data])

      useEffect(() => {
        const onFocus = () => { if (!busy) load(true) }
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [busy, load])

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

      return h('div', { style: S.root, 'data-edit-page': 'root' },
        h('div', { style: S.inner },
          h('div', { style: S.bar },
            h('span', { style: S.title }, LABEL),
            h('span', { style: S.hint }, '文字与思考可改，工具调用可改、结果只读'),
            h('span', { style: S.spacer }),
            entries.length > 0 ? h('span', { style: S.meta }, `${entries.length} 条`) : null,
            data?.running ? h('span', { style: { ...S.meta, color: 'var(--dsw-alias-state-warn-primary, #b8860b)' } }, '运行中') : null,
            h('button', { type: 'button', style: S.action, onClick: () => load(false) }, '刷新'),
            lastAssistant ? h('button', { type: 'button', style: S.action, onClick: () => jump(lastAssistant.seq) }, '最新 ↓') : null,
          ),

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
