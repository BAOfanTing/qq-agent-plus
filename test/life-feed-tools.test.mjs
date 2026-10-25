import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// tools-core 在模块求值期会读数据目录：先设 env，再动态 import（仓库的测试约定）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-life-feed-tools-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { buildToolDefs, executeTool } = await import('../src/tools/tools-core.js');
const defs = buildToolDefs();

test('生活层工具存在且声明了必要参数', () => {
  const next = defs.find((def) => def.name === 'life_feed_next');
  const feedback = defs.find((def) => def.name === 'life_feed_feedback');
  assert.ok(next, '缺少 life_feed_next');
  assert.ok(feedback, '缺少 life_feed_feedback');
  assert.deepEqual(feedback.parameters.required, ['bvid', 'action']);
  assert.deepEqual(feedback.parameters.properties.action.enum, ['shared', 'skip', 'more_like_this']);
});

test('life_feed_next 把队列条目裁成模型需要的字段', async () => {
  const feed = {
    next({ count, topic }) {
      assert.equal(count, 1);
      assert.equal(topic, '深海');
      return {
        items: [{
          id: 'BV1xx', title: '深海潜水', up: 'UP主', duration: 600, play: 1000,
          tags: ['户外'], url: 'https://www.bilibili.com/video/BV1xx', desc: '一条很长的简介'
        }]
      };
    }
  };
  const result = await executeTool(defs, { getLifeFeed: () => feed }, 'life_feed_next', JSON.stringify({ count: 1, topic: '深海' }));
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content);
  assert.equal(payload.items[0].bvid, 'BV1xx');
  assert.equal(payload.items[0].durationSec, 600);
  assert.match(payload.note, /别念标题/);
});

test('life_feed_next：生活层未开启 / 队列为空时返回可读错误', async () => {
  const missing = await executeTool(defs, {}, 'life_feed_next', '{}');
  assert.equal(missing.isError, true);
  assert.match(missing.content, /生活层没有开启/);

  const empty = await executeTool(defs, {
    getLifeFeed: () => ({ next: () => ({ error: '队列里没有可分享的候选' }) })
  }, 'life_feed_next', '{}');
  assert.equal(empty.isError, true);
  assert.match(empty.content, /队列里没有/);
});

test('life_feed_feedback 回写 shared/skip/more_like_this', async () => {
  const calls = [];
  const feed = {
    feedback(args) {
      calls.push(args);
      return { ok: true, action: args.action };
    }
  };
  const result = await executeTool(
    defs,
    { getLifeFeed: () => feed, chatKey: 'group:1' },
    'life_feed_feedback',
    JSON.stringify({ bvid: 'BV1xx', action: 'shared' })
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls[0], { id: 'BV1xx', action: 'shared', chatKey: 'group:1' });
});
