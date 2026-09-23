// Token 预算门禁不许在第一轮就吞掉整批消息。
//
// 背景（2026-09-23 全项目审查）：预算检查写在 round 0 之前，而"估算输入"只是按字符数折算的粗估 ——
// 一个繁忙会话的已读历史 + 触发批就能把它顶到预算线以上，于是这批消息会被 ack、一次模型都没调、
// 也不会重试（用户永远等不到回复）。修法：放过第一轮。
//
// 单独一个文件：这条要一个干净的数据目录（同一进程里多个用例共用 DATA_DIR 会串状态）。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-run-budget-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

it('预算线卡在最小值 + 满历史时，第一轮仍然要真的调用一次模型', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.api.maxRunTokens = 20000;      // 允许的最小值
  cfg.store.allCount = 300;          // 读满历史，把估算顶上去
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);

  const store = new ChatStore(0, { dataDir: dir });
  for (let i = 0; i < 250; i += 1) {
    store.appendIncoming('group:1', { mid: i + 1, text: `${i} `.repeat(20).trim(), senderId: '42', read: true });
  }
  let modelCalls = 0;
  const onebot = { getGroupInfo: async () => ({ group_name: 'test' }), sendText: async () => ({ message_id: 1 }) };
  const sender = new SendQueue({ store, onebot });
  const sessions = new SessionRegistry();
  const runner = new Orchestrator({ store, sessions, sender, onebot,
    stickers: {}, memory: { formatForPrompt: () => '' } });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    modelCalls += 1;
    return Response.json({
      choices: [{ message: { tool_calls: [{ id: 'finish-1', function: { name: 'finish', arguments: '{"summary":"looked"}' } }] } }],
      usage: { total_tokens: 10 }
    });
  };
  try {
    store.appendIncoming('group:1', { mid: 9999, text: '在吗', senderId: '42' });
    await runner.wake('group:1');
    assert.ok(modelCalls >= 1, `第一轮必须调用模型（实际 ${modelCalls} 次）—— 否则这批消息等于被吞`);
  } finally {
    globalThis.fetch = oldFetch;
    await runner.abortAll();
    store.close();
  }
});
