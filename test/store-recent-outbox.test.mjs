import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-recent-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { ChatStore } = await import('../src/core/store.js');

test('recent(afterId) 返回游标之后最早的一批，不跳过积压', () => {
  const store = new ChatStore(0, { dataDir: dir, filename: 'recent.sqlite' });
  try {
    const entries = [];
    for (let i = 0; i < 5; i += 1) {
      entries.push(store.appendIncoming('group:1', {
        mid: `m${i}`, ts: 1000 + i, senderId: '1', senderName: 'a', text: `t${i}`
      }));
    }
    const first = entries[0].id;
    const batch = store.recent('group:1', { afterId: first, limit: 2 });
    assert.deepEqual(batch.map((item) => item.text), ['t1', 't2']);
    // 非增量的既有语义不变：最新 N 条、按时间正序返回
    assert.deepEqual(store.recent('group:1', { limit: 2 }).map((item) => item.text), ['t3', 't4']);
  } finally {
    store.close();
  }
});

test('hasSelfSince 不受"最新 N 条"窗口影响', () => {
  const store = new ChatStore(0, { dataDir: dir, filename: 'self.sqlite' });
  try {
    store.appendSelf('group:1', { mid: 's0', ts: 1000, text: '旧' });
    assert.equal(store.hasSelfSince('group:1', 1001), false);
    assert.equal(store.hasSelfSince('group:1', 1000), true);
    store.appendSelf('group:1', { mid: 's1', ts: 2000, text: '新' });
    for (let i = 0; i < 30; i += 1) {
      store.appendIncoming('group:1', { mid: `x${i}`, ts: 2001 + i, senderId: '2', senderName: 'b', text: 'x' });
    }
    assert.equal(store.hasSelfSince('group:1', 1500), true, '自述被挤出最新 20 条也要能查到');
  } finally {
    store.close();
  }
});

test('pruneOutbox 只保留最近 N 条无 runId 的终态行', () => {
  const store = new ChatStore(0, { dataDir: dir, filename: 'outbox.sqlite' });
  try {
    for (let i = 0; i < 5; i += 1) {
      const id = store.beginSend('group:1', null, { text: `x${i}` });
      store.finishSend(id, { messageId: `m${i}`, outcome: 'sent' });
    }
    const runRow = store.beginSend('group:1', 'run-1', { text: 'keep' });
    store.finishSend(runRow, { outcome: 'sent' });

    assert.equal(store.pruneOutbox({ keep: 2 }), 3);
    const rows = store.db.prepare('SELECT id FROM outbox ORDER BY rowid').all();
    assert.equal(rows.length, 3, '保留 2 条无 runId + 1 条有 runId');
    assert.ok(rows.some((row) => row.id === runRow), '有 runId 的行不归这个清理管');
  } finally {
    store.close();
  }
});
