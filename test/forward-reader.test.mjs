import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readForwardMessages } from '../src/forward-reader.js';
import { buildToolDefs } from '../src/tools-core.js';

const card = [{ type: 'forward', data: { id: 'fresh-resource' } }];
const messages = [{ sender: { nickname: 'test' }, message: [{ type: 'text', data: { text: 'forward content' } }] }];

test('ingest reads a received resource ID without querying the wrong message_id', async () => {
  const calls = [];
  const onebot = { call: async (action, args) => {
    calls.push([action, args]);
    if (args.id === 'fresh-resource') return { messages };
    throw Object.assign(new Error('download forward message payload is empty'), { retcode: 100 });
  } };
  assert.deepEqual(await readForwardMessages(onebot, -123, card), messages);
  assert.deepEqual(calls, [['get_forward_msg', { id: 'fresh-resource' }]]);
});

test('tool resolves a fresh resource ID, saves expanded text, then uses the archive', async () => {
  const calls = [];
  const entry = { mid: '-123', text: '[合并转发聊天记录]' };
  const ctx = {
    chatKey: 'group:1',
    store: {
      findByMid: () => entry,
      updateByMid: (chat, mid, patch) => {
        assert.equal(chat, 'group:1'); assert.equal(mid, '-123'); entry.text = patch.text;
      }
    },
    onebot: { call: async (action, args) => {
      calls.push([action, args]);
      if (action === 'get_msg') return { message: card };
      if (args.id === 'fresh-resource') return { messages };
      throw new Error('wrong lookup');
    } }
  };
  const tool = buildToolDefs().find(t => t.name === 'read_forward');
  const result = await tool.execute(ctx, { messageId: '-123' });
  assert.equal(result.isError, undefined);
  assert.match(entry.text, /合并转发 共1条/);
  assert.match(entry.text, /forward content/);
  assert.deepEqual(calls, [['get_msg', { message_id: -123 }], ['get_forward_msg', { id: 'fresh-resource' }]]);
  await tool.execute(ctx, { messageId: '-123' });
  assert.equal(calls.length, 2);
});

test('older adapters can fall back to message_id when get_msg is unavailable', async () => {
  const onebot = { call: async (action, args) => {
    if (action === 'get_msg') throw new Error('unsupported');
    assert.deepEqual(args, { message_id: -123 });
    return { data: { messages } };
  } };
  assert.deepEqual(await readForwardMessages(onebot, -123), messages);
});

test('empty or rejected resource lookup has one bounded legacy fallback', async () => {
  for (const mode of ['empty', 'rejected']) {
    let calls = 0;
    const onebot = { call: async (_, args) => {
      calls++;
      if (args.id) {
        if (mode === 'rejected') throw Object.assign(new Error('empty payload'), { retcode: 100 });
        return { messages: [] };
      }
      return { messages };
    } };
    assert.deepEqual(await readForwardMessages(onebot, -123, card), messages);
    assert.equal(calls, 2);
  }
});

test('transport or authentication failures are not hidden by fallback', async () => {
  let calls = 0;
  const onebot = { call: async () => { calls++; throw new Error('HTTP 401'); } };
  await assert.rejects(readForwardMessages(onebot, -123, card), /HTTP 401/);
  assert.equal(calls, 1);
});
