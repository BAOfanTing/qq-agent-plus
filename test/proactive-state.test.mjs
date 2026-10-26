import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readProactiveAttempts, writeProactiveAttempt } from '../src/core/proactive-state.js';

const tempFile = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-proactive-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'proactive-state.json');
};

test('旧格式单时间戳迁移成群聊/私聊共用，升级后不会额外多一次机会', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, JSON.stringify({ lastAttemptAt: 123456 }));
  assert.deepEqual(readProactiveAttempts(file), { group: 123456, private: 123456 });
});

test('两个范围各自记录：写一个不会改另一个', (t) => {
  const file = tempFile(t);
  writeProactiveAttempt(file, 'group', 1000);
  writeProactiveAttempt(file, 'private', 2000);
  assert.deepEqual(readProactiveAttempts(file), { group: 1000, private: 2000 });
  writeProactiveAttempt(file, 'group', 3000);
  assert.deepEqual(readProactiveAttempts(file), { group: 3000, private: 2000 });
});

test('状态文件损坏/缺失按 0 处理，不抛错', (t) => {
  const file = tempFile(t);
  assert.deepEqual(readProactiveAttempts(file), { group: 0, private: 0 });
  fs.writeFileSync(file, '{坏 json');
  assert.deepEqual(readProactiveAttempts(file), { group: 0, private: 0 });
});

test('主动循环为群聊和私聊分别排程，候选也按范围过滤', () => {
  const source = fs.readFileSync(new URL('../src/core/orchestrator.js', import.meta.url), 'utf8');
  assert.match(source, /if \(scopes\.groups\) schedule\('group', 15000\)/);
  assert.match(source, /if \(scopes\.private\) schedule\('private', 15000\)/);
  assert.match(source, /#proactiveCandidates\(cfg, scope\)/);
  assert.match(source, /chatKeys: this\.store\.listChats\(\)\.filter\(\(key\) => String\(key\)\.startsWith\(prefix\)\)/);
});
