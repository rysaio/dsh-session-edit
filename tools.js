// Model-facing tools for dsh-session-edit.
//
// This module deliberately imports no Harness package: tool definitions use
// plain JSON Schema and the context supplies `tools`, `sessions`, `agents`,
// `sessionController`, `subagents`, and `workingDirectory`. That keeps the
// plugin loadable in profiles where `@deepseek-ai/dsh-tools` is not on the
// plugin's own resolution path, and keeps the pure helpers testable with Node.

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const WINDOW_SIZE = 4
export const READ_DEFAULT = 2
export const MAX_WAIT_MS = 120000
export const TOOL_TIMEOUT_MS = 180000

const EDIT_KINDS = new Set(['reasoning', 'text', 'tool-call'])

/** Error carrying a stable code for tool results. */
export function editError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** Owner recorded by session_edit_create, or undefined. */
export function ownerOf(target) {
  if (target === null || target === undefined) return undefined
  let events
  try { events = target.snapshotEvents?.() ?? [] } catch { return undefined }
  for (const event of events) {
    if (event?.type !== 'plugin:edit-page/owner') continue
    if (event.data?.version !== 1 || typeof event.data.owner !== 'string') continue
    return event.data.owner
  }
  return undefined
}

/** Whether `callerId` may operate on `target` (self, direct child, or owned). */
export function canAccess(callerId, target) {
  if (typeof callerId !== 'string' || callerId === '' || target === null || target === undefined) return false
  if (target.id === callerId) return true
  if (target.header?.parentSession === callerId) return true
  return ownerOf(target) === callerId
}

/** Durable session ids previously created from one caller session. */
export function createdSessionIds(session) {
  const ids = new Set()
  let events = []
  try { events = session?.snapshotEvents?.() ?? [] } catch { return [] }
  for (const event of events) {
    if (event?.type !== 'plugin:edit-page/created') continue
    if (event.data?.version !== 1 || typeof event.data.sessionId !== 'string') continue
    ids.add(event.data.sessionId)
  }
  return [...ids]
}

/** Resolve a create cwd: omitted means caller cwd; must stay in its subtree. */
export function resolveCreateCwd(callerCwd, requested) {
  if (typeof callerCwd !== 'string' || callerCwd === '') return null
  const base = path.resolve(callerCwd)
  if (requested === undefined || requested === null || requested === '') return base
  if (typeof requested !== 'string') return null
  const next = path.resolve(base, requested)
  const relative = path.relative(base, next)
  if (relative === '') return next
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return next
}

/** Create cwd must be a strict subdirectory: a real sub-workspace, not the caller root. */
export function resolveSubWorkspaceCwd(callerCwd, requested) {
  if (typeof callerCwd !== 'string' || callerCwd === '') return null
  if (typeof requested !== 'string' || requested.trim() === '') return null
  const base = path.resolve(callerCwd)
  const next = path.resolve(base, requested)
  const relative = path.relative(base, next)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return next
}

function textBlocks(message, type) {
  if (!Array.isArray(message?.content)) return []
  return message.content
    .filter(block => block?.type === type && typeof block.text === 'string')
    .map(block => block.text)
    .filter(text => text.trim() !== '')
}

/** One window entry from one assistant/message event; null when no text. */
export function windowEntryFromEvent(session, event) {
  if (!event || event.type !== 'assistant/message') return null
  const message = session.deriveEventMessage?.(event) ?? event.data?.message
  const reasoning = textBlocks(message, 'reasoning').join('\n\n')
  const text = textBlocks(message, 'text').join('\n\n')
  if (reasoning === '' && text === '') return null
  return { seq: event.seq, turn: event.data?.turn ?? null, reasoning, text }
}

/** One window entry from an already folded read entry. */
export function windowEntryFromReadEntry(session, entry) {
  if (!entry || entry.role !== 'assistant' || !Array.isArray(entry.blocks)) return null
  const reasoning = entry.blocks
    .filter(block => block.kind === 'reasoning' && typeof block.text === 'string')
    .map(block => block.text)
    .filter(text => text.trim() !== '')
    .join('\n\n')
  const text = entry.blocks
    .filter(block => block.kind === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .filter(value => value.trim() !== '')
    .join('\n\n')
  if (reasoning === '' && text === '') return null
  const event = session.eventAt?.(entry.seq)
  return { seq: entry.seq, turn: event?.data?.turn ?? null, reasoning, text }
}

/** Seed up to `WINDOW_SIZE` assistant entries from a live session. */
export function seedWindowEntries(session, collectEntries) {
  try {
    const entries = collectEntries(session).filter(entry => entry.role === 'assistant')
    return entries.map(entry => windowEntryFromReadEntry(session, entry)).filter(Boolean).slice(-WINDOW_SIZE)
  } catch {
    return []
  }
}

/**
 * Keep a bounded assistant-message window per (caller, child) pair.
 * Nothing in here touches a parent session: poll is the only reader.
 */
export class WindowStore {
  constructor({ size = WINDOW_SIZE } = {}) {
    this.size = size
    this.parents = new Map()
    this.owners = new Map()
  }

  ensure(callerId, childId, seed = []) {
    let children = this.parents.get(callerId)
    if (children === undefined) {
      children = new Map()
      this.parents.set(callerId, children)
    }
    let window = children.get(childId)
    if (window === undefined) {
      const entries = seed.filter(Boolean).slice(-this.size)
      window = {
        entries,
        cursor: entries.length === 0 ? 0 : entries[entries.length - 1].seq,
        waiters: new Set(),
        delivered: false,
      }
      children.set(childId, window)
      let owners = this.owners.get(childId)
      if (owners === undefined) {
        owners = new Set()
        this.owners.set(childId, owners)
      }
      owners.add(callerId)
    } else if (window.entries.length === 0 && seed.length > 0) {
      // The child may have produced its first messages before the tool
      // registered the watch; seed the still-empty window once.
      window.entries = seed.filter(Boolean).slice(-this.size)
      if (window.entries.length > 0) {
        window.cursor = Math.max(window.cursor, window.entries[window.entries.length - 1].seq)
      }
    }
    return window
  }

  has(callerId, childId) {
    return this.parents.get(callerId)?.has(childId) === true
  }

  observe(sessionId, event, session) {
    const owners = this.owners.get(sessionId)
    if (owners === undefined || owners.size === 0) return
    const entry = event?.type === 'assistant/message' ? windowEntryFromEvent(session, event) : null
    for (const callerId of [...owners]) {
      const window = this.parents.get(callerId)?.get(sessionId)
      if (window === undefined) continue
      if (event?.type === 'assistant/message') {
        window.cursor = Math.max(window.cursor, event.seq)
        if (entry !== null) this.push(window, entry)
      } else if (event?.type === 'turn/end') {
        this.wake(window)
      }
    }
  }

  push(window, entry) {
    const last = window.entries[window.entries.length - 1]
    if (last !== undefined && last.seq === entry.seq) return
    window.entries.push(entry)
    if (window.entries.length > this.size) window.entries.shift()
    window.cursor = Math.max(window.cursor, entry.seq)
    this.wake(window)
  }

  wake(window) {
    for (const waiter of [...window.waiters]) waiter.resolve()
    window.waiters.clear()
  }

  async poll(callerId, childId, { afterCursor, waitMs = 0, signal } = {}) {
    const window = this.ensure(callerId, childId)
    const from = Number.isSafeInteger(afterCursor) ? afterCursor : (window.delivered ? window.cursor : 0)
    const collect = () => window.entries.filter(entry => entry.seq > from)
    let entries = collect()
    let woke = false
    if (entries.length === 0 && waitMs > 0) woke = await this.wait(window, waitMs, signal)
    entries = collect()
    window.delivered = true
    return {
      entries,
      cursor: window.cursor,
      timedOut: entries.length === 0 && waitMs > 0 && !woke,
    }
  }

  wait(window, waitMs, signal) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        window.waiters.delete(waiter)
        signal?.removeEventListener?.('abort', onAbort)
        resolve(value)
      }
      const timer = setTimeout(() => finish(false), Math.min(Math.max(waitMs, 0), MAX_WAIT_MS))
      const waiter = { resolve: () => finish(true) }
      const onAbort = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        window.waiters.delete(waiter)
        signal?.removeEventListener?.('abort', onAbort)
        reject(signal?.reason ?? new Error('aborted'))
      }
      window.waiters.add(waiter)
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  disposeParent(callerId) {
    const children = this.parents.get(callerId)
    if (children === undefined) return
    for (const childId of children.keys()) {
      const owners = this.owners.get(childId)
      owners?.delete(callerId)
      if (owners !== undefined && owners.size === 0) this.owners.delete(childId)
    }
    this.parents.delete(callerId)
  }
}

/** Compact read entries; never mutates the folded input. */
export function pickReadEntries(entries, {
  lastN = READ_DEFAULT,
  beforeSeq,
  includeToolCalls = true,
  includeToolResults = false,
} = {}) {
  const count = Number.isSafeInteger(lastN) && lastN > 0 ? Math.min(lastN, 20) : READ_DEFAULT
  let list = Array.isArray(entries) ? entries : []
  if (Number.isSafeInteger(beforeSeq)) list = list.filter(entry => entry.seq < beforeSeq)
  const truncated = list.length > count
  list = list.slice(-count)
  const output = list.map(entry => {
    const blocks = (entry.blocks ?? [])
      .filter(block => includeToolCalls || block.kind !== 'tool-call')
      .map(block => {
        const copy = { ...block }
        if (!includeToolResults) delete copy.result
        return copy
      })
    return { ...entry, blocks }
  })
  return { entries: output, truncated }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonObject(raw) {
  if (typeof raw !== 'string') return null
  let value
  try { value = JSON.parse(raw) } catch { return null }
  return isPlainObject(value) ? value : null
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw editError('INVALID_ARGS', `${field} must be a non-empty string`)
  return value
}

function optionalText(value, field) {
  if (value !== undefined && typeof value !== 'string') throw editError('INVALID_ARGS', `${field} must be a string`)
  return value
}

function requireInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw editError('INVALID_ARGS', `${field} must be a non-negative integer`)
  return value
}

function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }
}

function parameters(properties, required = []) {
  return {
    type: 'object',
    properties,
    ...required.length === 0 ? {} : { required },
    additionalProperties: false,
  }
}

function json(value) {
  return JSON.stringify(value, null, 2)
}

/**
 * Register the model-facing tools. `helpers` supplies the shared edit/read
 * primitives from index.js so this module stays independent of the plugin's
 * HTTP half.
 */
export function registerEditTools(ctx, helpers) {
  let tools
  try {
    tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  } catch {
    return
  }
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return
  const { collectEntries, entryText, writeEdit, writeOwner, writeCreated, ensureDirectory = fs.mkdir } = helpers
  const services = {
    sessions: ctx.sessions,
    agents: ctx.agents,
    sessionController: ctx.sessionController,
  }
  const windows = new WindowStore()
  const createdByCaller = new Map()
  const getService = name => typeof ctx.get === 'function' ? ctx.get(name) : undefined

  ctx.on?.('session/event', (session, event) => {
    windows.observe(session.id, event, session)
  })
  ctx.on?.('session/disposed', session => {
    windows.disposeParent(session.id)
  })

  const ensureWorkspace = async cwd => {
    const registry = getService('workspaceRegistry')
    if (registry === undefined) throw editError('WORKSPACE_UNAVAILABLE', 'the workspace registry is unavailable')
    await ensureDirectory(cwd, { recursive: true })
    let workspace
    try { workspace = await registry.resolveByPath(cwd) } catch { workspace = undefined }
    if (workspace === undefined) workspace = await registry.create(cwd, path.basename(cwd))
    if (typeof workspace?.id !== 'string') throw editError('WORKSPACE_UNAVAILABLE', 'the workspace registry returned no id')
    return workspace
  }

  const archiveSession = async sessionId => {
    const registry = getService('workspaceRegistry')
    if (registry === undefined) throw editError('WORKSPACE_UNAVAILABLE', 'the workspace registry is unavailable')
    try {
      await registry.archiveSession(sessionId, { stopActivity: false })
    } catch (error) {
      throw editError('SESSION_ACTIVE', String(error?.message ?? error))
    }
  }

  const detachSession = async sessionId => {
    const registry = getService('workspaceRegistry')
    if (registry === undefined) return
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds.includes(sessionId)) continue
      try { await workspace.detachSession(sessionId) } catch {}
    }
  }

  const purgeFiles = async sessionId => {
    const persistence = getService('sessionPersistence')
    let location
    try {
      location = persistence?.stat === undefined ? undefined : (await persistence.stat(sessionId))?.location?.path
    } catch {}
    if (typeof location !== 'string' || location === '') return { purged: false, error: 'session has no stored location' }
    const directory = path.dirname(location)
    const home = path.resolve(directory, '..', '..', '..')
    const root = path.join(home, 'sessions')
    const relative = path.relative(root, directory)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { purged: false, error: 'session path is outside the DSH sessions root' }
    }
    try {
      await fs.rm(directory, { recursive: true, force: true })
    } catch (error) {
      return { purged: false, error: String(error?.message ?? error) }
    }
    const cache = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    try { await fs.rm(cache, { force: true }) } catch {}
    return { purged: true, path: location }
  }


  const requireAgent = exec => {
    const caller = exec?.agent
    if (caller === undefined || caller === null || typeof caller.id !== 'string') {
      throw editError('NO_CALLER', 'this tool requires a calling agent')
    }
    return caller
  }

  const ensureSession = async sessionId => {
    let session = services.sessions.get(sessionId)
    if (session !== undefined) return session
    const resolved = await services.sessionController.resolveAgent(sessionId)
    if (resolved?.error !== undefined) {
      throw editError('SESSION_NOT_LIVE', `session ${sessionId} could not be resolved`)
    }
    session = services.sessions.get(sessionId)
    if (session === undefined) throw editError('SESSION_NOT_LIVE', `session ${sessionId} is not live`)
    return session
  }

  const resolveTarget = async (exec, args) => {
    const caller = requireAgent(exec)
    const targetId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : caller.id
    const session = await ensureSession(targetId)
    if (!canAccess(caller.id, session)) {
      throw editError('SESSION_NOT_OWNED', `session ${targetId} is not the caller, a direct child, or an owned session`)
    }
    return { caller, session, targetId }
  }

  const runningOf = targetId => {
    const agent = services.agents.get(targetId)
    return agent !== undefined && agent.status !== 'idle'
  }

  const readTool = {
    name: 'session_edit_read',
    description: 'Read a session\'s visible reasoning, replies and tool calls. Defaults to the calling agent\'s own session; only self or a direct child is allowed. This is a snapshot, not a live window: use session_edit_poll for new reasoning/replies.',
    parameters: parameters({
      sessionId: { type: 'string', description: 'Target session id; defaults to the caller session.' },
      lastN: { type: 'integer', minimum: 1, maximum: 20, description: 'Number of final entries to return (default 2).' },
      beforeSeq: { type: 'integer', minimum: 0, description: 'Only return entries with seq lower than this.' },
      includeToolCalls: { type: 'boolean', description: 'Include tool-call blocks (default true).' },
      includeToolResults: { type: 'boolean', description: 'Include paired tool results (default false).' },
    }),
    output: textOutput(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { session, targetId } = await resolveTarget(exec, args)
      const picked = pickReadEntries(collectEntries(session), {
        lastN: args?.lastN,
        beforeSeq: args?.beforeSeq,
        includeToolCalls: args?.includeToolCalls !== false,
        includeToolResults: args?.includeToolResults === true,
      })
      return json({ ok: true, sessionId: targetId, running: runningOf(targetId), ...picked })
    },
  }

  const pollTool = {
    name: 'session_edit_poll',
    description: 'Return new reasoning/reply entries from a session window since a cursor. With waitMs > 0 it waits for the next assistant message or turn end. It does not inject anything into context; nothing is visible until you call it. Only self or a direct child is allowed.',
    parameters: parameters({
      sessionId: { type: 'string', description: 'Target session id; defaults to the caller session.' },
      afterCursor: { type: 'integer', minimum: 0, description: 'Return only entries with seq greater than this; defaults to the last returned cursor.' },
      waitMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS, description: 'Wait up to this many milliseconds for the next assistant message or turn end (default 0).' },
    }),
    output: textOutput(),
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const targetId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : caller.id
      if (!windows.has(caller.id, targetId)) {
        const { session } = await resolveTarget(exec, args)
        windows.ensure(caller.id, targetId, seedWindowEntries(session, collectEntries))
      }
      const polled = await windows.poll(caller.id, targetId, {
        afterCursor: args?.afterCursor,
        waitMs: Number.isSafeInteger(args?.waitMs) ? args.waitMs : 0,
        signal: exec.signal,
      })
      return json({ ok: true, sessionId: targetId, running: runningOf(targetId), ...polled })
    },
  }

  const applyTool = {
    name: 'session_edit_apply',
    description: 'Edit one existing reasoning, text or tool-call block in a session. The change is a projection record and is used by the model on the next turn; tools are not re-executed. The target must be idle. Only self or a direct child is allowed.',
    parameters: parameters({
      sessionId: { type: 'string', description: 'Target session id; defaults to the caller session.' },
      seq: { type: 'integer', minimum: 0, description: 'Assistant message seq.' },
      blockIndex: { type: 'integer', minimum: 0, description: 'Block index inside that message.' },
      kind: { type: 'string', enum: [...EDIT_KINDS], description: 'Block kind.' },
      text: { type: 'string', description: 'New text for reasoning/text.' },
      name: { type: 'string', description: 'New tool name for tool-call.' },
      arguments: { type: 'string', description: 'New tool arguments as a JSON object string.' },
      expectText: { type: 'string', description: 'Only edit when the current text equals this.' },
      expectName: { type: 'string', description: 'Only edit when the current tool name equals this.' },
      expectArguments: { type: 'string', description: 'Only edit when the current tool arguments equal this.' },
    }, ['seq', 'blockIndex', 'kind']),
    output: textOutput(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { session, targetId } = await resolveTarget(exec, args)
      if (runningOf(targetId)) throw editError('SESSION_RUNNING', 'the target session is running; wait for it to become idle')
      const seq = requireInteger(args?.seq, 'seq')
      const blockIndex = requireInteger(args?.blockIndex, 'blockIndex')
      const kind = args?.kind
      if (!EDIT_KINDS.has(kind)) throw editError('INVALID_ARGS', 'kind must be reasoning, text or tool-call')
      const current = entryText(session, seq, blockIndex)
      if (current === null || current.kind !== kind) {
        throw editError('NOT_EDITABLE', 'the target block is missing or no longer editable')
      }
      let record
      if (kind === 'tool-call') {
        const name = requiredText(args?.name, 'name').trim()
        if (name.length > 200) throw editError('INVALID_ARGS', 'name is too long')
        const raw = requiredText(args?.arguments, 'arguments')
        if (raw.length > 256 * 1024) throw editError('INVALID_ARGS', 'arguments are too long')
        if (jsonObject(raw) === null) throw editError('INVALID_ARGS', 'arguments must be a JSON object string')
        if (typeof args?.expectName === 'string' && args.expectName !== current.name) {
          throw editError('STALE_TARGET', 'tool name changed', { actualName: current.name })
        }
        if (typeof args?.expectArguments === 'string' && args.expectArguments !== current.arguments) {
          throw editError('STALE_TARGET', 'tool arguments changed', { actualArguments: current.arguments })
        }
        record = { version: 1, seq, blockIndex, kind, name, arguments: raw }
      } else {
        const text = requiredText(args?.text, 'text')
        if (text.length > 256 * 1024) throw editError('INVALID_ARGS', 'text is too long')
        if (typeof args?.expectText === 'string' && args.expectText !== current.text) {
          throw editError('STALE_TARGET', 'text changed', { actual: current.text })
        }
        record = { version: 1, seq, blockIndex, kind, text }
      }
      await writeEdit(session, record, services)
      const after = entryText(session, seq, blockIndex)
      return json({
        ok: true,
        sessionId: targetId,
        seq,
        blockIndex,
        kind,
        ...kind === 'tool-call'
          ? { name: after?.name ?? record.name, arguments: after?.arguments ?? record.arguments }
          : { text: after?.text ?? record.text },
      })
    },
  }

  const promptTool = {
    name: 'session_edit_prompt',
    description: 'Send a user message to a session. A running session queues it; an idle direct child starts a new turn. With waitMs > 0 it waits for idle and returns the final read window.',
    parameters: parameters({
      sessionId: { type: 'string', description: 'Target session id; defaults to the caller session.' },
      text: { type: 'string', description: 'Message text.' },
      waitMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS, description: 'Wait up to this many milliseconds for idle (default 0).' },
    }, ['text']),
    output: textOutput(),
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { targetId } = await resolveTarget(exec, args)
      const text = requiredText(args?.text, 'text')
      await services.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: targetId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, exec.signal)
      let waited = null
      let entries = null
      if (Number.isSafeInteger(args?.waitMs) && args.waitMs > 0) {
        const result = await services.sessionController.wait({
          sessionId: targetId,
          timeoutMs: Math.min(args.waitMs, MAX_WAIT_MS),
          maxMessages: READ_DEFAULT * 2,
        }, exec.signal)
        waited = { reason: result.reason, state: result.state }
        const session = await ensureSession(targetId)
        entries = pickReadEntries(collectEntries(session), { lastN: READ_DEFAULT }).entries
      }
      return json({ ok: true, sessionId: targetId, waited, entries })
    },
  }

  const createTool = {
    name: 'session_edit_create',
    description: 'Create a new ordinary session in a strict sub-workspace of the caller, record the caller as owner, and start its first task. The cwd is registered as a DSH workspace so the session is never grouped as Ungrouped.',
    parameters: parameters({
      prompt: { type: 'string', description: 'Initial task prompt for the new session.' },
      cwd: { type: 'string', description: 'Strict subdirectory of the caller cwd; it becomes a DSH workspace.' },
      agentPreset: { type: 'string', description: 'Optional agent preset id.' },
    }, ['prompt', 'cwd']),
    output: textOutput(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const caller = requireAgent(exec)
      if (typeof services.sessionController.create !== 'function') {
        throw editError('CREATE_UNAVAILABLE', 'sessionController.create is unavailable')
      }
      const callerCwd = getService('workingDirectory')?.get?.(caller.session) ?? caller.session?.header?.cwd
      const cwd = resolveSubWorkspaceCwd(callerCwd, args?.cwd)
      if (cwd === null) throw editError('CWD_OUTSIDE_WORKSPACE', 'cwd must be a strict subdirectory of the caller cwd')
      const prompt = requiredText(args?.prompt, 'prompt')
      const workspace = await ensureWorkspace(cwd).catch(error => {
        throw editError('WORKSPACE_UNAVAILABLE', String(error?.message ?? error))
      })
      const request = { workspaceId: workspace.id }
      if (typeof args?.agentPreset === 'string' && args.agentPreset !== '') request.agentPreset = args.agentPreset
      const newSession = await services.sessionController.create(request).catch(error => {
        throw editError('CREATE_UNAVAILABLE', String(error?.message ?? error))
      })
      if (typeof newSession?.sessionId !== 'string') throw editError('CREATE_UNAVAILABLE', 'sessionController.create returned no session id')
      const session = await ensureSession(newSession.sessionId)
      await writeOwner(session, caller.id, services)
      if (typeof writeCreated === 'function' && caller.session !== undefined) {
        try { await writeCreated(caller.session, newSession.sessionId, services) } catch {}
      }
      await services.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: newSession.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, exec.signal)
      let ids = createdByCaller.get(caller.id)
      if (ids === undefined) {
        ids = new Set()
        createdByCaller.set(caller.id, ids)
      }
      ids.add(newSession.sessionId)
      windows.ensure(caller.id, newSession.sessionId, [])
      return json({
        ok: true,
        sessionId: newSession.sessionId,
        workspaceId: workspace.id,
        workspaceTitle: workspace.title,
        cwd: workspace.path,
        agentPreset: newSession.agentPreset ?? null,
      })
    },
  }

  const deleteTool = {
    name: 'session_edit_delete',
    description: 'Archive one session you own (or a direct child), hiding it from the DSH workspace list. purge additionally removes its session log directory and projection cache after the archive; a live session may keep its file locked, in which case the archive still succeeds and purged is false.',
    parameters: parameters({
      sessionId: { type: 'string', description: 'Session to delete; must be self-owned/child/owner, not the caller itself.' },
      mode: { type: 'string', enum: ['archive', 'purge'], description: 'archive (default) hides only; purge also tries to delete files.' },
      confirm: { type: 'boolean', description: 'Must be true for purge.' },
    }, ['sessionId']),
    output: textOutput(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { caller, targetId } = await resolveTarget(exec, args)
      if (targetId === caller.id) throw editError('CANNOT_DELETE_SELF', 'the caller cannot delete its own session')
      if (runningOf(targetId)) throw editError('SESSION_RUNNING', 'the target session is running')
      const mode = args?.mode === 'purge' ? 'purge' : 'archive'
      if (mode === 'purge' && args?.confirm !== true) throw editError('CONFIRM_REQUIRED', 'purge requires confirm: true')
      await archiveSession(targetId)
      let purge = null
      if (mode === 'purge') {
        await detachSession(targetId)
        purge = await purgeFiles(targetId)
        if (purge.purged) createdByCaller.get(caller.id)?.delete(targetId)
      }
      return json({ ok: true, sessionId: targetId, mode, archived: true, ...purge })
    },
  }

  const cleanupTool = {
    name: 'session_edit_cleanup',
    description: 'Archive or purge sessions created by this caller in this process, plus its live direct children. Requires confirm: true. Useful for clearing subagent/probe sessions from the DSH workspace list.',
    parameters: parameters({
      mode: { type: 'string', enum: ['archive', 'purge'], description: 'archive (default) hides only; purge also tries to delete files.' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    }, ['confirm']),
    output: textOutput(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const caller = requireAgent(exec)
      if (args?.confirm !== true) throw editError('CONFIRM_REQUIRED', 'cleanup requires confirm: true')
      const mode = args?.mode === 'purge' ? 'purge' : 'archive'
      const ids = new Set(createdByCaller.get(caller.id) ?? [])
      for (const id of createdSessionIds(caller.session)) ids.add(id)
      for (const session of services.sessions.list()) {
        if (session.header?.parentSession === caller.id) ids.add(session.id)
      }
      const archived = []
      const purged = []
      const skipped = []
      const failed = []
      for (const sessionId of ids) {
        if (sessionId === caller.id) continue
        if (runningOf(sessionId)) {
          skipped.push({ sessionId, reason: 'running' })
          continue
        }
        try {
          await archiveSession(sessionId)
          archived.push(sessionId)
          if (mode === 'purge') {
            await detachSession(sessionId)
            const result = await purgeFiles(sessionId)
            if (result.purged) {
              purged.push(sessionId)
              createdByCaller.get(caller.id)?.delete(sessionId)
            } else {
              failed.push({ sessionId, error: result.error })
            }
          }
        } catch (error) {
          failed.push({ sessionId, error: String(error?.message ?? error) })
        }
      }
      return json({ ok: true, mode, archived, purged, skipped, failed })
    },
  }

  for (const definition of [readTool, pollTool, applyTool, promptTool, createTool, deleteTool, cleanupTool]) {
    tools.register(definition)
  }
}
