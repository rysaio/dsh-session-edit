// dsh-session-edit — Host half.
//
// 编辑只写「投影事件」：原始 assistant/message 一字不动，插件在折叠历史时
// 把目标块替换成编辑后的文本。因此
//   · 模型下一轮直接使用改后的内容，不需要重启；
//   · 关闭插件或重启 DSH 时，事件被跳过，历史回到原文；
//   · 不提供「仅落盘」路径，也不改写会话文件。
//
// 事件用 appendPluginRecord 写成 ignorable 的 plugin: 记录，读取端缺插件时
// 会静默跳过，不会让会话打不开。

import { createRequire } from 'node:module'
import { registerEditTools } from './tools.js'

export const name = 'dsh-session-edit'
export const inject = ['webServer', 'sessions', 'agents', 'sessionController']

/** 本插件写入的会话记录类型。 */
export const RECORD_TYPE = 'plugin:edit-page/change'

/** 进程内单例：投影对象只注册一次，停用时只关掉开关，绝不注销。 */
const CELL = Symbol.for('dsh-edit-page.projection')
export const cell = globalThis[CELL] ??= { active: false, registered: false, projection: null }

/** 会话记录里 block.type → 对外种类。 */
function kindOf(block) {
  if (!block || typeof block !== 'object') return null
  if (block.type === 'text') return 'text'
  if (block.type === 'reasoning' || block.type === 'thinking') return 'reasoning'
  if (block.type === 'tool-call') return 'tool-call'
  return null
}

/** 解析成 JSON 对象；非法 JSON 或数组/标量返回 null。 */
function jsonObject(raw) {
  if (typeof raw !== 'string') return null
  let value
  try { value = JSON.parse(raw) } catch { return null }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
}

/** 读一个可编辑块；不可编辑返回 null。 */
function readBlock(content, index) {
  if (!Array.isArray(content)) return null
  if (!Number.isSafeInteger(index) || index < 0) return null
  const block = content[index]
  const kind = kindOf(block)
  if (kind === null) return null
  if (kind === 'tool-call') {
    if (typeof block.id !== 'string' || typeof block.name !== 'string' || typeof block.arguments !== 'string') return null
    return { kind, id: block.id, name: block.name, arguments: block.arguments }
  }
  if (typeof block.text !== 'string') return null
  return { kind, text: block.text }
}

/**
 * 改写块时剥掉对原文生效的签名：正文一改就与签名不符，部分 provider 会拒掉
 * 整条请求。块上的和 source.replayState 里的都要剥。
 */
function stripReplayFields(source, indexes, fields) {
  if (!source || typeof source !== 'object') return null
  const replay = source.replayState
  if (!replay || typeof replay !== 'object' || !Array.isArray(replay.blocks)) return null
  let changed = false
  const blocks = replay.blocks.map((block, index) => {
    if (!indexes.includes(index)) return block
    if (!block || typeof block !== 'object') return block
    if (!fields.some(field => field in block)) return block
    changed = true
    const copy = { ...block }
    for (const field of fields) delete copy[field]
    return copy
  })
  if (!changed) return null
  return { ...source, replayState: { ...replay, blocks } }
}

/** 校验一条记录的数据体。 */
function validData(data) {
  if (!data || data.version !== 1) return false
  if (!Number.isSafeInteger(data.seq) || data.seq < 0) return false
  if (!Number.isSafeInteger(data.blockIndex) || data.blockIndex < 0) return false
  if (data.kind === 'text' || data.kind === 'reasoning') return typeof data.text === 'string'
  if (data.kind === 'tool-call') {
    return typeof data.name === 'string' && data.name.trim() !== ''
      && typeof data.arguments === 'string' && jsonObject(data.arguments) !== null
  }
  return false
}

/**
 * patch 投影：把目标块替换成记录里的文本/工具调用。
 * 任何异常都退化成「不覆盖」，避免整条会话折叠失败。
 */
export function project(event, context) {
  const out = new Map()
  if (!cell.active) return out
  const data = event?.data
  if (!validData(data)) return out
  const nodes = context?.nodes
  if (!Array.isArray(nodes) || !nodes.includes(data.seq)) return out
  const events = Array.isArray(context?.events) ? context.events : []
  const baseSeq = typeof context?.baseSeq === 'number' ? context.baseSeq : 0
  const source = events[data.seq - baseSeq]
  if (!source || source.type !== 'assistant/message') return out
  const previous = context?.messages?.get?.(data.seq)
  const base = previous ?? source.data?.message
  const view = readBlock(base?.content, data.blockIndex)
  if (view === null || view.kind !== data.kind) return out
  const content = base.content.slice()
  const patched = { ...content[data.blockIndex] }
  const fields = []
  if (data.kind === 'tool-call') {
    patched.name = data.name
    patched.arguments = data.arguments
    fields.push('thoughtSignature')
  } else {
    patched.text = data.text
    if (data.kind === 'reasoning') {
      delete patched.signature
      delete patched.thinkingSignature
      fields.push('signature')
    }
  }
  content[data.blockIndex] = patched
  const message = { ...base, content }
  if (fields.length > 0) {
    const stripped = stripReplayFields(base.source, [data.blockIndex], fields)
    if (stripped !== null) message.source = stripped
  }
  out.set(data.seq, message)
  return out
}

/** 解析宿主自己的 dsh-session（必须与活会话同一个模块实例）。 */
let sessionApi
function hostSessionApi() {
  if (sessionApi !== undefined) return sessionApi
  const anchor = process.env.COT_DSH_RUNTIME_ANCHOR || process.argv[1]
  const runtime = createRequire(anchor)('@deepseek-ai/dsh-session')
  if (typeof runtime.appendPluginRecord !== 'function') {
    throw new Error('宿主未提供 appendPluginRecord')
  }
  sessionApi = runtime
  return sessionApi
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('invalid-json')) }
    })
    req.on('error', reject)
  })
}

/** 用户消息 → 只保留纯文本块。 */
function userEntry(event) {
  const message = event.data
  const kind = message?.source?.kind
  if (kind !== 'user' && kind !== 'user-rpc') return null
  if (!Array.isArray(message.content)) return null
  const text = message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim()
  if (text === '') return null
  return { seq: event.seq, role: 'user', text }
}

/** 工具结果只读展示的字符上限，超出截断并标记。 */
const RESULT_TEXT_MAX = 4000

/** 工具结果 → 只读摘要；调用卡据此显示配对结果。 */
function resultEntry(session, event) {
  const base = event.data?.message
  const message = session.deriveEventMessage(event) ?? base
  const callId = message?.toolCallId
  if (typeof callId !== 'string' || callId === '' || !Array.isArray(message.content)) return null
  const text = message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
  const truncated = text.length > RESULT_TEXT_MAX
  return {
    callId,
    seq: event.seq,
    isError: message.isError === true,
    text: truncated ? text.slice(0, RESULT_TEXT_MAX) : text,
    ...truncated ? { truncated: true } : {},
  }
}

/** 助手消息 → 投影后的可编辑块。 */
function assistantEntry(session, event, results) {
  const base = event.data?.message
  if (!Array.isArray(base?.content)) return null
  const message = session.deriveEventMessage(event) ?? base
  const blocks = []
  for (let index = 0; index < message.content.length; index += 1) {
    const view = readBlock(message.content, index)
    if (view === null) continue
    // 空思考块不展示：有的回合只有工具调用，露出一行「思考（空）」没有意义。
    if (view.kind === 'reasoning' && view.text.trim() === '') continue
    const origin = readBlock(base.content, index)
    if (origin === null || origin.kind !== view.kind) continue
    if (view.kind === 'tool-call') {
      const patched = view.name !== origin.name || view.arguments !== origin.arguments
      const result = results.get(view.id)
      blocks.push({
        blockIndex: index,
        kind: view.kind,
        name: view.name,
        arguments: view.arguments,
        patched,
        ...patched ? { original: { name: origin.name, arguments: origin.arguments } } : {},
        ...result === undefined ? {} : { result },
      })
      continue
    }
    const patched = view.text !== origin.text
    blocks.push({
      blockIndex: index,
      kind: view.kind,
      text: view.text,
      patched,
      ...patched ? { original: origin.text } : {},
    })
  }
  if (blocks.length === 0) return null
  return { seq: event.seq, role: 'assistant', blocks }
}

/** 收集当前会话里可展示的历史（工具结果只读，挂在对应调用上）。 */
function collect(session) {
  const nodes = [...session.surface.nodes]
  const results = new Map()
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!event || event.type !== 'tool/result') continue
    const entry = resultEntry(session, event)
    if (entry === null) continue
    const { callId, ...result } = entry
    results.set(callId, result)
  }
  const entries = []
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'user/message') {
      const entry = userEntry(event)
      if (entry !== null) entries.push(entry)
      continue
    }
    if (event.type === 'assistant/message') {
      const entry = assistantEntry(session, event, results)
      if (entry !== null) entries.push(entry)
    }
  }
  return entries
}

/** Shared with the model-facing tools. */
export const collectEntries = collect

export function entryText(session, seq, blockIndex) {
  const event = session.eventAt(seq)
  if (!event || event.type !== 'assistant/message') return null
  const message = session.deriveEventMessage(event) ?? event.data?.message
  return readBlock(message?.content, blockIndex)
}

export function apply(ctx) {
  // 先把服务抓成局部引用：路由是异步回调，插件被停用/热重载后旧的 ctx 会变成
  // inactive，再去读 ctx.sessions 就会抛 cannot get required service。
  const sessions = ctx.sessions
  const agents = ctx.agents
  const webServer = ctx.webServer
  const sessionController = ctx.sessionController

  // 投影对象每个进程只造一次：会话折叠时保存的是这个对象的引用，
  // 换新对象会让它判定 "projection was removed or replaced"。
  cell.projection ??= { type: RECORD_TYPE, project }
  cell.generation = (cell.generation ?? 0) + 1
  const generation = cell.generation
  cell.active = true

  // 注册交给根上下文上的看护插件：插件的 ctx 卸载时，直接注册的投影会被一起
  // 回收，已用过它的会话下一次折叠就会报 "projection was removed"。看护插件
  // 活到进程结束，停用编辑插件只是关掉 cell.active，会话永远不需要重新找定义。
  const registered = Array.isArray(sessions.messageProjections)
    && sessions.messageProjections.some(item => item.type === RECORD_TYPE)
  if (!registered) {
    const projection = cell.projection
    const register = () => {
      try {
        sessions.registerMessageProjection(projection)
      } catch (error) {
        if (!/already registered/.test(String(error?.message ?? error))) throw error
      }
    }
    try {
      cell.keeper = ctx.root.plugin({
        name: 'edit-page-projection',
        apply: register,
      })
    } catch {
      // 组合期不允许挂根插件时退回本插件上下文：能注册，但停用插件会一起被回收。
      register()
    }
  }

  const disposers = []
  const route = (path, handler) => {
    disposers.push(webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        try {
          const origin = req.headers.origin
          if (typeof origin === 'string' && origin !== '' && origin !== webServer.getOrigin()) {
            json(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          const result = handler(req, res, { sessions, agents, sessionController })
          if (result && typeof result.then === 'function') {
            result.catch(error => json(res, 500, { ok: false, error: String(error?.message ?? error) }))
          }
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
  }

  route('/api/edit-page/v1/session', (req, res, services) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    return handleSession(services, req, res)
  })

  route('/api/edit-page/v1/apply', (req, res, services) => handleApply(services, req, res))

  route('/api/edit-page/v1/fork', (req, res, services) => handleFork(services, req, res))

  try {
    registerEditTools(ctx, { collectEntries: collect, entryText, writeEdit, writeOwner, writeCreated })
  } catch (error) {
    ctx.logger?.warn?.(`edit-page tools: ${String(error?.message ?? error)}`)
  }

  // 停用只关开关，不注销投影：注销会让用过它的会话在下一次折叠时报
  // "projection was removed"，那一轮对话就发不出去。路由则必须撤掉，
  // 否则旧闭包会继续对着已停用的上下文取服务。
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 已随上下文回收 */ }
    }
    if (cell.generation === generation) cell.active = false
  }, 'edit-page routes')
}

/** 一页读取的条数上限；不传 limit 时用默认窗口。 */
const WINDOW_LIMIT = 30

function handleSession(services, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (sessionId === '') return json(res, 400, { ok: false, error: 'sessionId required' })
  const session = typeof services.sessions.get === 'function' ? services.sessions.get(sessionId) : undefined
  if (session === undefined) {
    return json(res, 409, { ok: false, code: 'SESSION_NOT_LIVE', error: '会话未载入，打开该会话后再试' })
  }
  const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  const limit = Number.isSafeInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : WINDOW_LIMIT
  const beforeParam = Number.parseInt(url.searchParams.get('before') ?? '', 10)
  const before = Number.isSafeInteger(beforeParam) && beforeParam >= 0 ? beforeParam : null
  const all = collect(session)
  let end = all.length
  if (before !== null) {
    end = all.findIndex(entry => entry.seq === before)
    if (end < 0) {
      return json(res, 409, { ok: false, code: 'WINDOW_STALE', error: '分页位置已失效，请刷新' })
    }
  }
  const start = Math.max(0, end - limit)
  const agent = services.agents.get(sessionId)
  const running = Boolean(agent && agent.status !== 'idle')
  return json(res, 200, {
    ok: true,
    active: cell.active,
    projectionRegistered: Array.isArray(services.sessions.messageProjections)
      && services.sessions.messageProjections.some(item => item.type === RECORD_TYPE),
    sessionId,
    running,
    entries: all.slice(start, end),
    hasMore: start > 0,
  })
}

/** Shared write path: append the projection record and wait for one flush. */
export async function writeEdit(session, record, services) {
  const api = hostSessionApi()
  api.appendPluginRecord(session, RECORD_TYPE, record)
  await services.sessions.flush(session)
}

/** Ownership record for sessions created by the model-facing create tool. */
export async function writeOwner(session, owner, services) {
  const api = hostSessionApi()
  api.appendPluginRecord(session, 'plugin:edit-page/owner', { version: 1, owner })
  await services.sessions.flush(session)
}

/** Durable list of sessions created by this caller, kept on the caller session. */
export async function writeCreated(session, childId, services) {
  const api = hostSessionApi()
  api.appendPluginRecord(session, 'plugin:edit-page/created', { version: 1, sessionId: childId })
  await services.sessions.flush(session)
}

async function handleApply(services, req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
  if (req.headers['x-edit-page'] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
  const body = await readBody(req)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  if (sessionId === '') return json(res, 400, { ok: false, error: 'sessionId required' })
  const seq = body?.seq
  const blockIndex = body?.blockIndex
  const kind = body?.kind
  if (!Number.isSafeInteger(seq) || seq < 0) return json(res, 400, { ok: false, error: 'seq required' })
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) return json(res, 400, { ok: false, error: 'blockIndex required' })
  if (kind !== 'text' && kind !== 'reasoning' && kind !== 'tool-call') {
    return json(res, 400, { ok: false, error: 'kind must be text, reasoning or tool-call' })
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const args = body.arguments
  const text = body.text
  if (kind === 'tool-call') {
    if (name === '') return json(res, 400, { ok: false, error: '工具名不能为空' })
    if (name.length > 200) return json(res, 413, { ok: false, error: '工具名过长' })
    if (typeof args !== 'string') return json(res, 400, { ok: false, error: 'arguments required' })
    if (args.length > 256 * 1024) return json(res, 413, { ok: false, error: '参数过长' })
    if (jsonObject(args) === null) return json(res, 400, { ok: false, error: '参数必须是 JSON 对象' })
  } else {
    if (typeof text !== 'string' || text.trim() === '') return json(res, 400, { ok: false, error: '内容不能为空' })
    if (text.length > 256 * 1024) return json(res, 413, { ok: false, error: '内容过长' })
  }

  const session = typeof services.sessions.get === 'function' ? services.sessions.get(sessionId) : undefined
  if (session === undefined) {
    return json(res, 409, { ok: false, code: 'SESSION_NOT_LIVE', error: '会话未载入，打开该会话后再试' })
  }
  const agent = services.agents.get(sessionId)
  if (agent && agent.status !== 'idle') {
    return json(res, 409, { ok: false, code: 'SESSION_RUNNING', error: '模型正在运行，等这一轮结束后再改' })
  }
  const current = entryText(session, seq, blockIndex)
  if (current === null || current.kind !== kind) {
    return json(res, 409, { ok: false, code: 'NOT_EDITABLE', error: '这条内容已经不可编辑（可能已被压缩或改写）' })
  }
  const stale = kind === 'tool-call'
    ? (typeof body.expectName === 'string' && body.expectName !== current.name)
      || (typeof body.expectArguments === 'string' && body.expectArguments !== current.arguments)
    : typeof body.expectText === 'string' && body.expectText !== current.text
  if (stale) {
    return json(res, 409, {
      ok: false,
      code: 'STALE_TARGET',
      error: '内容已在别处更新，请刷新后再改',
      ...kind === 'tool-call'
        ? { actualName: current.name, actualArguments: current.arguments }
        : { actual: current.text },
    })
  }

  const record = kind === 'tool-call'
    ? { version: 1, seq, blockIndex, kind, name, arguments: args }
    : { version: 1, seq, blockIndex, kind, text }
  await writeEdit(session, record, services)

  const after = entryText(session, seq, blockIndex)
  return json(res, 200, {
    ok: true,
    seq,
    blockIndex,
    kind,
    ...kind === 'tool-call'
      ? { name: after?.name ?? name, arguments: after?.arguments ?? args }
      : { text: after?.text ?? text },
  })
}

/**
 * 分叉点之后才写下的改稿记录：分叉只复制到 boundary 为止，
 * 这些记录要补进子会话，子会话的历史才是「编辑过」的那一版。
 */
export function pendingRecords(session, boundary) {
  const records = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== RECORD_TYPE || !validData(event.data)) continue
    if (event.data.seq > boundary) continue
    if (event.seq <= boundary) continue
    records.push(event.data)
  }
  return records
}

async function handleFork(services, req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
  if (req.headers['x-edit-page'] !== '1') return json(res, 403, { ok: false, error: 'forbidden' })
  const body = await readBody(req)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const seq = body?.seq
  if (sessionId === '') return json(res, 400, { ok: false, error: 'sessionId required' })
  if (!Number.isSafeInteger(seq) || seq < 0) return json(res, 400, { ok: false, error: 'seq required' })

  const session = typeof services.sessions.get === 'function' ? services.sessions.get(sessionId) : undefined
  if (session === undefined) {
    return json(res, 409, { ok: false, code: 'SESSION_NOT_LIVE', error: '会话未载入，打开该会话后再试' })
  }
  const agent = services.agents.get(sessionId)
  if (agent && agent.status !== 'idle') {
    return json(res, 409, { ok: false, code: 'SESSION_RUNNING', error: '模型正在运行，等这一轮结束后再分叉' })
  }
  const event = session.eventAt(seq)
  if (!event || event.type !== 'assistant/message' || !session.surface.nodes.includes(seq)) {
    return json(res, 400, { ok: false, code: 'NOT_OUTPUT', error: '只能从当前可见的模型回复处分叉' })
  }

  const forked = await services.sessionController.fork({ sessionId, atSeq: seq })
  const childId = forked?.sessionId
  if (typeof childId !== 'string' || childId === '') {
    return json(res, 500, { ok: false, error: '宿主没有返回新会话编号' })
  }
  if (services.sessions.get(childId) === undefined) {
    const resolved = await services.sessionController.resolveAgent(childId)
    if (resolved?.error) throw resolved.error
  }
  const child = services.sessions.get(childId)

  let copied = 0
  if (child !== undefined) {
    const api = hostSessionApi()
    for (const record of pendingRecords(session, seq)) {
      api.appendPluginRecord(child, RECORD_TYPE, record)
      copied += 1
    }
    if (copied > 0) await services.sessions.flush(child)
  }
  return json(res, 200, { ok: true, sessionId: childId, from: sessionId, seq, copied })
}

