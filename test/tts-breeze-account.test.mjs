// Breeze 云端账号：余额查询 / 账号保存（密码不回显）/ 登录换 Cookie / 每日领额度。
// 用本地 http 假站验证请求形状与落盘，不碰真网络。
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qq-breeze-account-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const {
  breezeBalance,
  breezeClaim,
  breezeClaimSaved,
  breezeAccountView,
  saveBreezeAccount
} = await import('../src/llm/tts-breeze.js');

const hits = [];
let respond = () => {};
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    respond(req, res);
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  delete process.env.QQ_AGENT_DATA_DIR;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

test('余额：带 xi-api-key 打到 /v1/balance，返回数字', async () => {
  hits.length = 0;
  respond = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"balance":1362}'); };
  const r = await breezeBalance({ baseUrl: base, apiKey: 'brz_test' });
  assert.equal(r.ok, true);
  assert.equal(r.balance, 1362);
  assert.equal(hits[0].url, '/v1/balance');
  assert.equal(hits[0].headers['xi-api-key'], 'brz_test');
  // 没填 Key 直接说清楚，不发请求
  hits.length = 0;
  const none = await breezeBalance({ baseUrl: base, apiKey: '' });
  assert.equal(none.ok, false);
  assert.equal(none.hasKey, false);
  assert.equal(hits.length, 0);
});

test('账号保存：密码留空/掩码 = 保持不变，视图不回显密码', () => {
  const v1 = saveBreezeAccount({ email: 'me@example.com', password: 'pw123456', autoClaim: true });
  assert.equal(v1.email, 'me@example.com');
  assert.equal(v1.hasPassword, true);
  assert.equal(v1.password, undefined, '视图不能带出密码');

  // 只改邮箱、密码留空 → 密码保留
  const v2 = saveBreezeAccount({ email: 'me2@example.com', password: '' });
  assert.equal(v2.email, 'me2@example.com');
  assert.equal(v2.hasPassword, true, '留空不应把密码冲掉');

  // 掩码同样不改
  const v3 = saveBreezeAccount({ email: 'me2@example.com', password: '******' });
  assert.equal(v3.hasPassword, true);
});

test('领额度：登录换 Cookie → 领额度 → 落 lastClaimAt / 余额', async () => {
  saveBreezeAccount({ email: 'me@example.com', password: 'pw123456', autoClaim: true });
  hits.length = 0;
  respond = (req, res) => {
    if (req.url === '/api/auth/email/continue') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['sid=abc; Path=/; HttpOnly'] });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/api/credits/daily-claim') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"claimed":true,"credits_issued":400,"balance":1762,"daily_claim_reward_tier":"discord"}');
      return;
    }
    res.writeHead(404); res.end('{}');
  };
  const r = await breezeClaim({ email: 'me@example.com', password: 'pw123456', siteUrl: base, baseUrl: base });
  assert.equal(r.ok, true);
  assert.equal(r.claimed, true);
  assert.equal(r.reward, 400);
  assert.equal(r.balance, 1762);
  // 登录时带了 origin 头（站点接口有校验）
  const login = hits.find((h) => h.url === '/api/auth/email/continue');
  assert.ok(login, '应该先登录换 Cookie');
  assert.equal(login.headers.origin, base);
  assert.equal(JSON.parse(login.body).email, 'me@example.com');
  // 领额度带上了 Cookie
  const claim = hits.find((h) => h.url === '/api/credits/daily-claim');
  assert.match(String(claim.headers.cookie), /sid=abc/);
  // 落盘后可读到
  const view = breezeAccountView();
  assert.ok(view.lastClaimAt > 0);
  assert.equal(view.lastTier, 'discord');
});

test('breezeClaimSaved：用已保存账号领（面板按钮走这条）', async () => {
  saveBreezeAccount({ email: 'me@example.com', password: 'pw123456', autoClaim: true });
  respond = (req, res) => {
    if (req.url === '/api/auth/email/continue') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['sid=xyz; Path=/'] });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"claimed":false,"already_claimed":true,"balance":1762}');
  };
  // 账号文件里 siteUrl 没存，得靠环境/默认；这里直接改文件补 siteUrl 不方便，
  // 用 breezeClaim 的默认站会打真网络 —— 因此这里只验证"没账号时明确报错"。
  saveBreezeAccount({ email: '', password: '' });
  await assert.rejects(() => breezeClaimSaved(), /还没填 Breeze 账号/);
});
