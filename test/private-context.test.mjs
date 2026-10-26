import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-private-context-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } });

const { ChatStore } = await import('../src/core/store.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { buildPastState } = await import('../src/llm/prompt.js');
const { buildToolDefs, executeTool } = await import('../src/tools/tools.js');

function seed() {
  const store = new ChatStore(0);
  store.appendIncoming('private:1', { mid: 11, ts: 1000, senderId: '1', senderName: 'A', text: '和 A 说的话' });
  store.appendIncoming('private:2', { mid: 22, ts: 2000, senderId: '2', senderName: 'B', text: '和 B 说的话' });
  store.appendIncoming('private:1', { mid: 12, ts: 3000, senderId: '1', senderName: 'A', text: 'A 又说了一句' });
  store.drainUnread('private:1');
  store.drainUnread('private:2');
  return store;
}

function configWith(shared) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.privateSharedContext = shared;
  cfg.store.allCount = 500;
  cfg.store.pastStateMaxChars = 100000;
  setRuntimeConfig(cfg);
}

test('store.recent(scope=private) 跨私聊按时间读取，默认仍只读当前会话', () => {
  configWith(false);
  const store = seed();
  const only = store.recent('private:1', { limit: 10 });
  assert.deepEqual(only.map((m) => m.text), ['和 A 说的话', 'A 又说了一句']);
  assert.equal(only[0].chatKey, 'private:1');

  const all = store.recent('private:1', { limit: 10, scope: 'private' });
  assert.deepEqual(all.map((m) => m.text), ['和 A 说的话', '和 B 说的话', 'A 又说了一句']);
  assert.deepEqual(all.map((m) => m.chatKey), ['private:1', 'private:2', 'private:1']);
  store.close();
});

test('私聊共享上下文：历史带 [与 <QQ>] 标签，别的会话 mid 不暴露；默认关仍隔离', async () => {
  configWith(true);
  const store = seed();
  const state = buildPastState(store, 'private:1');
  assert.match(state.text, /和 B 说的话/);
  assert.match(state.text, /\[与 2\]/);
  assert.doesNotMatch(state.text, /#22/);
  assert.match(state.text, /#11/);

  const tool = buildToolDefs().find((d) => d.name === 'get_recent_messages');
  const result = await executeTool([tool], {
    chatKey: 'private:1',
    store,
    session: { pastStateCount: 0 }
  }, 'get_recent_messages', JSON.stringify({ limit: 10 }));
  const payload = JSON.parse(result.content);
  const cross = payload.messages.find((m) => m.text.includes('和 B 说的话'));
  assert.ok(cross);
  assert.match(cross.text, /^\[与 2\]/);
  assert.equal(cross.messageId, undefined);

  configWith(false);
  const isolated = buildPastState(store, 'private:1');
  assert.doesNotMatch(isolated.text, /和 B 说的话/);
  store.close();
});
