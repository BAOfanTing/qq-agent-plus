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
const { safeFetchBinary } = await import('../src/llm/safe-fetch.js');

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
