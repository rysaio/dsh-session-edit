import test from 'node:test'
import assert from 'node:assert/strict'
import { cell, pendingRecords, project } from './index.js'

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
