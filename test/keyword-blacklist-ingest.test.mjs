// 关键词黑名单的 ingest 集成：命中的消息在入口丢弃（不入库、不触发模型），
// 普通消息照常入库。用真实 createApp + 真实 ChatStore，事件通过 app.onebot.onEvent 注入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-kw-blacklist-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function boot() {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.allow = { ...(cfg.allow || {}), groups: ['1'], private: [] };
  cfg.onebot = { ...(cfg.onebot || {}), wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', accessToken: '' };
  cfg.api = { ...(cfg.api || {}), baseUrl: '', apiKey: '', model: 'deepseek-flash', priceRemoteUrl: 'none' };
  cfg.store = { ...(cfg.store || {}), blacklistKeywords: ['广告', 're:^转发.*抽奖$'] };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  await app.start();
  return app;
}

const groupEvent = (mid, text) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: 1,
  user_id: 42,
  message_id: mid,
  time: Math.floor(Date.now() / 1000),
  raw_message: text,
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: 42, nickname: '群友' }
});

test('黑名单命中的消息不入库；普通消息照常入库', async (t) => {
  const app = await boot();
  t.after(async () => {
    await app.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  app.onebot.onEvent(groupEvent(1001, '正常聊天'));
  app.onebot.onEvent(groupEvent(1002, '这里是广告内容'));
  app.onebot.onEvent(groupEvent(1003, '转发这条抽奖'));
  await new Promise((resolve) => setTimeout(resolve, 250));

  // 不用 readOnly：observe 模式下消息停在 pending，readOnly 只看 acked
  const rows = app.store.recent('group:1', { limit: 50, includeSelf: true });
  assert.equal(rows.length, 1, `只应留下普通消息，实际：${JSON.stringify(rows.map((r) => r.text))}`);
  assert.equal(rows[0].text, '正常聊天');
  assert.equal(app.store.findByMid('group:1', 1002), null, '普通关键词命中要丢弃');
  assert.equal(app.store.findByMid('group:1', 1003), null, '正则命中要丢弃');
  assert.ok(app.store.findByMid('group:1', 1001), '普通消息不能被误杀');
});
