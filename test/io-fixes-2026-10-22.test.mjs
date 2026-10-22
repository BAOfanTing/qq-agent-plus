// Issue #45：控制台轮询不能因为"运行中的会话每几秒重写一次 JSON"就整份重扫所有会话文件。
// session 文件重写走 rename，会改目录 mtime —— 以前缓存签名用目录 mtime，等于每次写盘都
// 让 /api/status 的用量缓存失效。签名必须只看文件增删。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-io-sig-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } });

const sessionsDir = path.join(dataDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const write = (name, body = '{}') => fs.writeFileSync(path.join(sessionsDir, name), body);

const { sessionsDirSignature } = await import('../src/console/app.js');

test('用量缓存签名只看会话文件增删，不看运行中重写', () => {
  write('a.json');
  write('b.json');
  const base = sessionsDirSignature();
  assert.ok(base, '目录里有两个文件时签名不能为空');

  // 运行中会话的节流落盘：同名文件整份重写（tmp → rename），目录 mtime 会变
  const later = new Date(Date.now() + 60_000);
  write('a.json', JSON.stringify({ id: 'a', text: 'progress' }));
  fs.utimesSync(path.join(sessionsDir, 'a.json'), later, later);
  assert.equal(sessionsDirSignature(), base, '同名重写不能让缓存失效');

  // 新会话 / 删除会话必须能检测到
  write('c.json');
  const added = sessionsDirSignature();
  assert.notEqual(added, base, '新增文件必须换签名');
  fs.rmSync(path.join(sessionsDir, 'b.json'));
  assert.notEqual(sessionsDirSignature(), added, '删除文件必须换签名');
});
