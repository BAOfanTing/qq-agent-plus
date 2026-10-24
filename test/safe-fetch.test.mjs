import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 用例自己造临时数据目录：**不许**碰仓库里的 data/（那里可能是真配置，含 Key）。
// 注意 ESM 的静态 import 会先于文件体执行，所以 src 模块必须用动态 import 放在这之后。
const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-safe-fetch-'));
process.env.QQ_AGENT_DATA_DIR = __dir;
process.on('exit', () => { try { fs.rmSync(__dir, { recursive: true, force: true }); } catch { /* Windows 上可能被句柄占着 */ } });

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { safeFetchBinary, readBounded } = await import('../src/llm/safe-fetch.js');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('safeFetchBinary rejects an oversized response instead of returning truncated bytes', async (t) => {
  setRuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    security: { allowPrivateImageHosts: true }
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([1, 2, 3, 4, 5]));
  });
  const port = await listen(server);
  t.after(() => server.close());

  await assert.rejects(
    safeFetchBinary(`http://127.0.0.1:${port}/image`, 4),
    /超过 4 字节限制/
  );
});

test('safeFetchBinary accepts a response exactly at the byte limit', async (t) => {
  setRuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    security: { allowPrivateImageHosts: true }
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  const port = await listen(server);
  t.after(() => server.close());

  const result = await safeFetchBinary(`http://127.0.0.1:${port}/image`, 4);
  assert.deepEqual(result.buffer, Buffer.from([1, 2, 3, 4]));
});

test('readBounded：正好等于上限（自然读尽）不标 truncated；超过才中断并标（2026-10-09 审查）', async () => {
  // 旧实现用 `total >= maxBytes` 中断 + 拿 body 长度反推 truncated：正好一页（50000 字节）
  // 的完整响应会被误标成"截断"；而截断后的英文页长度恰好也是 50000，反推又会漏标。
  // 现在 truncated 由读取路径如实带出。
  const { EventEmitter } = await import('node:events');
  const fakeRes = () => {
    const ee = new EventEmitter();
    ee.destroyCalled = false;
    ee.destroy = () => { ee.destroyCalled = true; };
    return ee;
  };

  // ① 正好等于上限：完整响应，不许中断、不许标 truncated
  const exact = fakeRes();
  const p1 = readBounded(exact, 10, true);
  exact.emit('data', Buffer.from('0123456789'));
  exact.emit('end');
  assert.deepEqual(await p1, { body: '0123456789', truncated: false });
  assert.equal(exact.destroyCalled, false, '正好等于上限不该中断连接');

  // ② 超过一字节：中断 + 截到上限 + truncated=true
  const over = fakeRes();
  const p2 = readBounded(over, 10, true);
  over.emit('data', Buffer.from('0123456789ab'));
  assert.equal(over.destroyCalled, true, '超限必须中断连接');
  assert.deepEqual(await p2, { body: '0123456789', truncated: true });
});

test('域名白名单：初始 URL 与每一跳重定向都复检（isHostAllowed + 实际 302）', async () => {
  const { safeFetchRequest, safeFetchBinary, isHostAllowed } = await import('../src/llm/safe-fetch.js');

  // 纯函数口径：子域放行、同后缀不同域拒绝、大小写与结尾点归一
  assert.equal(isHostAllowed('api.bilibili.com', ['bilibili.com']), true);
  assert.equal(isHostAllowed('evilbilibili.com', ['bilibili.com']), false, '同后缀不同域不能放行');
  assert.equal(isHostAllowed('BILIBILI.COM.', ['bilibili.com']), true);
  assert.equal(isHostAllowed('x.com', []), true, '空名单 = 不启用域名限制');

  // 真实 302：127.0.0.1 在名单里，localhost 不在 —— 重定向到 localhost 必须被拦
  let bHits = 0;
  const serverB = http.createServer((_req, res) => { bHits += 1; res.writeHead(200); res.end('LEAK'); });
  const serverA = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://localhost:${serverB.address().port}/x` });
    res.end();
  });
  // 不指定 host：默认绑 ::（双栈），127.0.0.1 与 localhost(→::1) 都能到达 ——
  // 本机 localhost 优先解析成 ::1，只绑 127.0.0.1 的对照组会连接被拒
  await new Promise((resolve) => serverA.listen(0, resolve));
  await new Promise((resolve) => serverB.listen(0, resolve));
  const aUrl = `http://127.0.0.1:${serverA.address().port}/start`;
  await assert.rejects(
    safeFetchRequest(aUrl, { allowPrivate: true, allowedDomains: ['127.0.0.1'] }),
    /白名单/
  );
  await assert.rejects(
    safeFetchBinary(aUrl, 1000, undefined, { allowPrivate: true, allowedDomains: ['127.0.0.1'] }),
    /白名单/
  );
  assert.equal(bHits, 0, '被拦的重定向不能碰到达端');
  // 名单覆盖两台主机时放行（对照组：证明拒绝确实来自白名单而不是别的守卫）
  const allowed = await safeFetchRequest(aUrl, { allowPrivate: true, allowedDomains: ['127.0.0.1', 'localhost'] });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body, 'LEAK');
  serverA.close();
  serverB.close();
  // Node 19+ 的默认 agent 开 keep-alive：不掐掉存量连接的话，测试进程会因服务器句柄未释放而挂住
  serverA.closeAllConnections?.();
  serverB.closeAllConnections?.();
});
