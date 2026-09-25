import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// /api/login 的按源失败退避（loginGate）：控制台 token 是唯一凭据，
// 没有 429 退避的话暴露面（deploy-all 绑 0.0.0.0）上可以无成本穷举。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-login-gate-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('login gate: 连续失败后 429 退避，正确令牌也先被挡下', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: 'login-gate-token' };
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  updateConfig(cfg);

  const app = createApp({ log: () => {} });
  t.after(() => app.stop());
  await app.start(port);

  const post = (token) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ token });
    const rq = http.request({
      host: '127.0.0.1', port, path: '/api/login', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(d || '{}') }));
    });
    rq.on('error', reject);
    rq.write(body);
    rq.end();
  });

  for (let i = 0; i < 5; i += 1) {
    const res = await post('wrong-token');
    assert.equal(res.status, 401, `第 ${i + 1} 次失败应仍是 401`);
  }
  // 第 6 次起进入退避：即便令牌正确也先被 429 挡下（loginGate 在令牌校验之前）
  const blocked = await post('login-gate-token');
  assert.equal(blocked.status, 429, '连续 5 次失败后应返回 429');
  assert.match(blocked.json.error, /尝试过于频繁，请 \d+ 秒后再试/);
});
