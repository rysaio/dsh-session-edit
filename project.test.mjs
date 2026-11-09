import test from 'node:test'
import assert from 'node:assert/strict'
import { cell, pendingRecords, project } from './index.js'
import { canAccess, pickReadEntries, registerEditTools, resolveCreateCwd, resolveSubWorkspaceCwd, WindowStore } from './tools.js'

const RECORD = 'plugin:edit-page/change'

function context(overrides = {}) {
  const event = {
    type: 'assistant/message',
    seq: 5,
    data: {
      message: {
        id: 'm1',
        role: 'assistant',
        source: {
          kind: 'model',
          replayState: {
            blocks: [
              { type: 'reasoning', signature: 'sig' },
              { type: 'text' },
              { type: 'tool-call', thoughtSignature: 'ts', namespace: 'ns' },
            ],
          },
        },
        content: [
          { type: 'reasoning', text: 'old thinking', signature: 'sig' },
          { type: 'text', text: 'old text' },
          { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' },
        ],
      },
    },
  }
  return {
    event,
    context: {
      nodes: [5],
      events: [...Array.from({ length: 5 }, (_, seq) => ({ type: 'turn/start', seq, data: {} })), event],
      baseSeq: 0,
      messages: new Map(),
      ...overrides,
    },
  }
}

function record(overrides = {}) {
  return {
    type: RECORD,
    data: { version: 1, seq: 5, blockIndex: 1, kind: 'text', text: 'new text', ...overrides },
  }
}

function callRecord(overrides = {}) {
  return {
    type: RECORD,
    data: {
      version: 1, seq: 5, blockIndex: 2, kind: 'tool-call',
      name: 'write', arguments: '{"path":"b"}',
      ...overrides,
    },
  }
}

test('停用时不覆盖任何消息', () => {
  cell.active = false
  const { context: ctx } = context()
  assert.equal(project(record(), ctx).size, 0)
})

test('改写正文块', () => {
  cell.active = true
  const { context: ctx } = context()
  const out = project(record(), ctx)
  const message = out.get(5)
  assert.equal(message.content[1].text, 'new text')
  assert.equal(message.content[0].text, 'old thinking')
})

test('改写推理块同时剥掉两处签名', () => {
  cell.active = true
  const { context: ctx } = context()
  const out = project(record({ blockIndex: 0, kind: 'reasoning', text: 'new thinking' }), ctx)
  const message = out.get(5)
  assert.equal(message.content[0].text, 'new thinking')
  assert.equal('signature' in message.content[0], false)
  assert.equal('signature' in message.source.replayState.blocks[0], false)
})

test('改写工具调用的名字与参数，保留配对 id', () => {
  cell.active = true
  const { context: ctx } = context()
  const out = project(callRecord(), ctx)
  const message = out.get(5)
  assert.deepEqual(message.content[2], {
    type: 'tool-call', id: 'call-1', name: 'write', arguments: '{"path":"b"}',
  })
  assert.equal(message.content[1].text, 'old text')
})

test('改写工具调用剥掉 thoughtSignature，保留 namespace', () => {
  cell.active = true
  const { context: ctx } = context()
  const out = project(callRecord(), ctx)
  assert.deepEqual(out.get(5).source.replayState.blocks[2], { type: 'tool-call', namespace: 'ns' })
})

test('工具调用参数必须是 JSON 对象', () => {
  cell.active = true
  const { context: ctx } = context()
  assert.equal(project(callRecord({ arguments: '[1]' }), ctx).size, 0)
  assert.equal(project(callRecord({ arguments: '{bad' }), ctx).size, 0)
  assert.equal(project(callRecord({ arguments: '' }), ctx).size, 0)
})

test('工具名不能为空白', () => {
  cell.active = true
  const { context: ctx } = context()
  assert.equal(project(callRecord({ name: '  ' }), ctx).size, 0)
})

test('目标不在当前 surface 上时跳过', () => {
  cell.active = true
  const { context: ctx } = context({ nodes: [] })
  assert.equal(project(record(), ctx).size, 0)
})

test('种类不符时跳过', () => {
  cell.active = true
  const { context: ctx } = context()
  assert.equal(project(record({ kind: 'reasoning' }), ctx).size, 0)
})

test('数据体不合法时跳过', () => {
  cell.active = true
  const { context: ctx } = context()
  assert.equal(project(record({ version: 2 }), ctx).size, 0)
  assert.equal(project({ type: RECORD, data: null }, ctx).size, 0)
})

test('叠加前一次投影后的文本', () => {
  cell.active = true
  const { event, context: ctx } = context()
  const previous = {
    ...event.data.message,
    content: [{ type: 'reasoning', text: 'old thinking' }, { type: 'text', text: 'first edit' }],
  }
  ctx.messages.set(5, previous)
  const out = project(record({ text: 'second edit' }), ctx)
  assert.equal(out.get(5).content[1].text, 'second edit')
})

test('分叉只带走边界内、且不在复制前缀里的改稿记录', () => {
  const events = [
    { type: 'assistant/message', seq: 5, data: {} },
    { type: RECORD, seq: 8, data: { version: 1, seq: 5, blockIndex: 1, kind: 'text', text: 'a' } },
    { type: RECORD, seq: 30, data: { version: 1, seq: 5, blockIndex: 1, kind: 'text', text: 'b' } },
    { type: RECORD, seq: 31, data: { version: 1, seq: 9, blockIndex: 1, kind: 'text', text: 'c' } },
    { type: RECORD, seq: 32, data: { version: 9, seq: 5, blockIndex: 1, kind: 'text', text: 'bad' } },
  ]
  const session = { snapshotEvents: () => events }
  assert.deepEqual(pendingRecords(session, 6).map(item => item.text), ['a', 'b'])
  assert.deepEqual(pendingRecords(session, 8).map(item => item.text), ['b'])
  assert.deepEqual(pendingRecords(session, 9).map(item => item.text), ['b', 'c'])
})

test('权限只允许自己、直接子会话或 owner 记录', () => {
  const self = { id: 'a', header: {} }
  const child = { id: 'b', header: { parentSession: 'a' } }
  const sibling = { id: 'c', header: { parentSession: 'x' } }
  const owned = {
    id: 'd',
    header: {},
    snapshotEvents: () => [{ type: 'plugin:edit-page/owner', data: { version: 1, owner: 'a' } }],
  }
  assert.equal(canAccess('a', self), true)
  assert.equal(canAccess('a', child), true)
  assert.equal(canAccess('a', owned), true)
  assert.equal(canAccess('a', sibling), false)
  assert.equal(canAccess('b', sibling), false)
  assert.equal(canAccess('a', null), false)
})

test('create 的 cwd 只能落在调用者子树内', () => {
  const root = 'C:\\work\\case'
  assert.equal(resolveCreateCwd(root, undefined), root)
  assert.equal(resolveCreateCwd(root, 'sub'), 'C:\\work\\case\\sub')
  assert.equal(resolveCreateCwd(root, '..\\other'), null)
  assert.equal(resolveCreateCwd(root, 'C:\\other'), null)
  assert.equal(resolveCreateCwd('', 'sub'), null)
})

test('子工作区 cwd 必须是严格子目录', () => {
  const root = 'C:\\work\\case'
  assert.equal(resolveSubWorkspaceCwd(root, 'sub'), 'C:\\work\\case\\sub')
  assert.equal(resolveSubWorkspaceCwd(root, 'a\\b'), 'C:\\work\\case\\a\\b')
  assert.equal(resolveSubWorkspaceCwd(root, undefined), null)
  assert.equal(resolveSubWorkspaceCwd(root, '.'), null)
  assert.equal(resolveSubWorkspaceCwd(root, '..\\other'), null)
  assert.equal(resolveSubWorkspaceCwd(root, 'C:\\other'), null)
})

test('窗口只保留最近条数并按 cursor 返回增量', async () => {
  const store = new WindowStore({ size: 2 })
  const session = {
    deriveEventMessage: event => event.data.message,
    eventAt: () => undefined,
  }
  const event = (seq, text) => ({
    type: 'assistant/message',
    seq,
    data: { turn: seq, message: { content: [{ type: 'reasoning', text: `r${seq}` }, { type: 'text', text }] } },
  })
  store.ensure('caller', 'child', [])
  store.observe('child', event(1, 'one'), session)
  store.observe('child', event(2, 'two'), session)
  store.observe('child', event(3, 'three'), session)
  const all = await store.poll('caller', 'child', { afterCursor: 0 })
  assert.deepEqual(all.entries.map(entry => entry.text), ['two', 'three'])
  assert.equal(all.cursor, 3)
  const delta = await store.poll('caller', 'child', { afterCursor: 2 })
  assert.deepEqual(delta.entries.map(entry => entry.text), ['three'])
})

test('poll waitMs 等到下一条或 turn/end，超时返回 timedOut', async () => {
  const store = new WindowStore({ size: 2 })
  const session = { deriveEventMessage: event => event.data.message }
  store.ensure('caller', 'child', [])
  const waiting = store.poll('caller', 'child', { afterCursor: 0, waitMs: 1000 })
  store.observe('child', {
    type: 'assistant/message',
    seq: 4,
    data: { turn: 4, message: { content: [{ type: 'text', text: 'four' }] } },
  }, session)
  const woke = await waiting
  assert.deepEqual(woke.entries.map(entry => entry.text), ['four'])
  assert.equal(woke.timedOut, false)

  const timeout = await store.poll('caller', 'child', { afterCursor: 4, waitMs: 10 })
  assert.equal(timeout.timedOut, true)
})

test('窗口已存在但为空时会补种历史', async () => {
  const store = new WindowStore({ size: 2 })
  store.ensure('caller', 'child', [])
  store.ensure('caller', 'child', [{ seq: 9, turn: 1, reasoning: 'r', text: 'seeded' }])
  const picked = await store.poll('caller', 'child')
  assert.deepEqual(picked.entries.map(entry => entry.text), ['seeded'])
  assert.equal(picked.cursor, 9)
})

test('read 只取最近 N 条，默认不带工具结果', () => {
  const entries = [
    { seq: 1, role: 'user', text: 'u1' },
    { seq: 2, role: 'assistant', blocks: [{ blockIndex: 0, kind: 'text', text: 'a2' }] },
    { seq: 3, role: 'assistant', blocks: [
      { blockIndex: 0, kind: 'text', text: 'a3' },
      { blockIndex: 1, kind: 'tool-call', name: 'pwsh', arguments: '{}', result: { seq: 4, text: 'secret' } },
    ] },
  ]
  const picked = pickReadEntries(entries, { lastN: 2 })
  assert.equal(picked.entries.length, 2)
  assert.equal(picked.truncated, true)
  assert.equal('result' in picked.entries[1].blocks[1], false)
  const withResult = pickReadEntries(entries, { lastN: 1, includeToolResults: true })
  assert.equal(withResult.entries[0].blocks[1].result.text, 'secret')
})

test('注册七个模型工具并能读写调用者自己的会话', async () => {
  const definitions = new Map()
  const registry = { register(definition) { definitions.set(definition.name, definition) } }
  const session = {
    id: 'caller',
    header: {},
    surface: { nodes: [] },
    eventAt: () => undefined,
    deriveEventMessage: () => null,
  }
  const ctx = {
    get(name) { return name === 'tools' ? registry : undefined },
    sessions: { get: id => id === 'caller' ? session : undefined, flush: async () => true },
    agents: { get: () => ({ status: 'idle' }) },
    sessionController: {},
    on: () => {},
  }
  let written = null
  registerEditTools(ctx, {
    collectEntries: () => [{ seq: 1, role: 'assistant', blocks: [{ blockIndex: 0, kind: 'text', text: 'hello' }] }],
    entryText: () => ({ kind: 'text', text: 'hello' }),
    writeEdit: async (_session, record) => { written = record },
  })
  assert.deepEqual([...definitions.keys()].sort(), [
    'session_edit_apply',
    'session_edit_cleanup',
    'session_edit_create',
    'session_edit_delete',
    'session_edit_poll',
    'session_edit_prompt',
    'session_edit_read',
  ])
  const exec = { agent: { id: 'caller' }, signal: new AbortController().signal }
  const read = JSON.parse(await definitions.get('session_edit_read').execute({ lastN: 1 }, exec))
  assert.equal(read.entries[0].blocks[0].text, 'hello')
  const polled = JSON.parse(await definitions.get('session_edit_poll').execute({}, exec))
  assert.equal(polled.entries[0].text, 'hello')
  assert.equal(polled.cursor, 1)
  const applied = JSON.parse(await definitions.get('session_edit_apply').execute({
    seq: 1, blockIndex: 0, kind: 'text', text: 'new text',
  }, exec))
  assert.equal(applied.ok, true)
  assert.deepEqual(written, { version: 1, seq: 1, blockIndex: 0, kind: 'text', text: 'new text' })
})

test('create 建普通会话、写 owner 并启动首轮', async () => {
  const definitions = new Map()
  const registry = { register(definition) { definitions.set(definition.name, definition) } }
  const childSession = { id: 'child-1', header: { cwd: 'C:\\work\\case\\sub' } }
  const workspace = { id: 'ws-1', title: 'sub', path: 'C:\\work\\case\\sub', sessionIds: [] }
  let createdRequest = null
  let writtenOwner = null
  let prompted = null
  let createdWorkspace = null
  const ctx = {
    get(name) {
      if (name === 'tools') return registry
      if (name === 'workingDirectory') return { get: () => 'C:\\work\\case' }
      if (name === 'workspaceRegistry') return {
        resolveByPath: async () => undefined,
        create: async (path, title) => { createdWorkspace = { path, title }; return workspace },
      }
      return undefined
    },
    sessions: { get: id => id === 'child-1' ? childSession : undefined, flush: async () => true },
    agents: { get: () => ({ status: 'idle' }) },
    sessionController: {
      create: async request => { createdRequest = request; return { sessionId: 'child-1', agentPreset: 'standard' } },
      prompt: async request => { prompted = request },
    },
    on: () => {},
  }
  registerEditTools(ctx, {
    collectEntries: () => [],
    entryText: () => null,
    writeEdit: async () => {},
    writeOwner: async (session, owner) => { writtenOwner = { session, owner } },
    ensureDirectory: async () => {},
  })
  const caller = { id: 'caller', session: { header: { cwd: 'C:\\work\\case' } } }
  const created = JSON.parse(await definitions.get('session_edit_create').execute({
    prompt: 'do it', cwd: 'sub',
  }, { agent: caller, signal: new AbortController().signal }))
  assert.equal(created.sessionId, 'child-1')
  assert.equal(created.workspaceId, 'ws-1')
  assert.equal(createdWorkspace.path, 'C:\\work\\case\\sub')
  assert.equal(created.cwd, 'C:\\work\\case\\sub')
  assert.equal(createdRequest.workspaceId, 'ws-1')
  assert.equal('cwd' in createdRequest, false)
  assert.equal(writtenOwner.owner, 'caller')
  assert.equal(writtenOwner.session, childSession)
  assert.equal(prompted.sessionId, 'child-1')
  assert.equal(prompted.mode, 'queue')
  assert.equal(prompted.content[0].text, 'do it')
  await assert.rejects(
    definitions.get('session_edit_create').execute({ prompt: 'x', cwd: '..\\out' }, { agent: caller, signal: new AbortController().signal }),
    /CWD_OUTSIDE_WORKSPACE/,
  )
})

test('delete/cleanup 归档并尝试清理文件', async () => {
  const definitions = new Map()
  const registry = { register(definition) { definitions.set(definition.name, definition) } }
  const archived = []
  const detached = []
  const callerSession = { id: 'caller', header: {} }
  const childSession = { id: 'child', header: { parentSession: 'caller' }, surface: { nodes: [] } }
  const workspace = {
    id: 'ws-1',
    path: 'C:\\work\\case\\sub',
    title: 'sub',
    sessionIds: ['child'],
    detachSession: async id => { detached.push(id) },
  }
  const ctx = {
    get(name) {
      if (name === 'tools') return registry
      if (name === 'workspaceRegistry') return {
        archiveSession: async (id, options) => { archived.push({ id, options }) },
        list: () => [workspace],
      }
      if (name === 'sessionPersistence') return { stat: async () => ({}) }
      return undefined
    },
    sessions: {
      get: id => id === 'caller' ? callerSession : id === 'child' ? childSession : undefined,
      list: () => [childSession],
      flush: async () => true,
    },
    agents: { get: () => ({ status: 'idle' }) },
    sessionController: {},
    on: () => {},
  }
  registerEditTools(ctx, {
    collectEntries: () => [],
    entryText: () => null,
    writeEdit: async () => {},
    writeOwner: async () => {},
  })
  const exec = { agent: { id: 'caller' }, signal: new AbortController().signal }
  const deleted = JSON.parse(await definitions.get('session_edit_delete').execute({
    sessionId: 'child', mode: 'purge', confirm: true,
  }, exec))
  assert.equal(deleted.archived, true)
  assert.equal(deleted.purged, false)
  assert.deepEqual(archived.map(item => item.id), ['child'])
  assert.deepEqual(detached, ['child'])
  const cleaned = JSON.parse(await definitions.get('session_edit_cleanup').execute({ confirm: true }, exec))
  assert.deepEqual(cleaned.archived, ['child'])
})

test('prompt 自己与子会话都走 sessionController.queue', async () => {  const definitions = new Map()
  const registry = { register(definition) { definitions.set(definition.name, definition) } }
  const callerSession = { id: 'caller', header: {} }
  const childSession = { id: 'child', header: { parentSession: 'caller' } }
  const prompts = []
  const ctx = {
    get(name) { return name === 'tools' ? registry : undefined },
    sessions: { get: id => id === 'caller' ? callerSession : id === 'child' ? childSession : undefined },
    agents: { get: () => ({ status: 'idle' }) },
    sessionController: {
      prompt: async request => { prompts.push(request) },
    },
    on: () => {},
  }
  registerEditTools(ctx, { collectEntries: () => [], entryText: () => null, writeEdit: async () => {} })
  const exec = { agent: { id: 'caller' }, signal: new AbortController().signal }
  await definitions.get('session_edit_prompt').execute({ text: 'hello self' }, exec)
  assert.equal(prompts[0].sessionId, 'caller')
  assert.equal(prompts[0].mode, 'queue')
  await definitions.get('session_edit_prompt').execute({ sessionId: 'child', text: 'hello child' }, exec)
  assert.equal(prompts[1].sessionId, 'child')
  assert.equal(prompts[1].mode, 'queue')
  assert.deepEqual(prompts[1].content, [{ type: 'text', text: 'hello child' }])
})
