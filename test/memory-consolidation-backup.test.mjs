import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-backup-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { backupPersonBeforeConsolidation } = await import('../src/memory/memory-consolidation-backup.js');
const { MemoryStore } = await import('../src/memory/memory.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('consolidation keeps append-only global history and legacy latest snapshot', () => {
  const person = {
    version: 2,
    userId: '114514',
    name: '测试人物',
    impressions: [
      { content: '旧印象 A', createdAt: 100, lastObservedAt: 200, sourceChatKeys: ['group:456'] },
      { content: '旧印象 B', createdAt: 300, lastObservedAt: 400, sourceChatKeys: ['private:114514'] }
    ],
    sourceChatKeys: ['group:456', 'private:114514'],
    updatedAt: 400,
    lastConsolidatedAt: 0
  };

  const first = backupPersonBeforeConsolidation(person, {
    sourceChatKey: 'group:456',
    at: 1000
  });
  const second = backupPersonBeforeConsolidation(person, {
    sourceChatKey: 'group:456',
    at: 2000
  });

  assert.ok(first && second && first !== second);
  const historyDir = path.join(dataDir, 'memory', 'backups', 'consolidation', '114514');
  const history = fs.readdirSync(historyDir).filter((name) => name.endsWith('.json'));
  assert.equal(history.length, 2, 'global audit history must be append-only');

  const payload = JSON.parse(fs.readFileSync(second, 'utf8'));
  assert.equal(payload.reason, 'consolidation');
  assert.equal(payload.sourceChatKey, 'group:456');
  assert.equal(payload.backedUpAt, 2000);
  assert.deepEqual(payload.person, person);

  const legacy = JSON.parse(fs.readFileSync(
    path.join(dataDir, 'memory', 'backups', 'group_456', '114514.json'),
    'utf8'
  ));
  assert.deepEqual(legacy, person, 'legacy path keeps the latest pre-consolidation person snapshot');
});

test('real replaceMember path snapshots same-source destructive writes', () => {
  const memory = new MemoryStore();
  memory.append('group:456', 'memberImpression', '真实调用链里的旧印象', {
    userId: '1919810',
    target: '集成人物'
  });
  const before = memory.getMember('', '1919810');

  memory.replaceMember('group:456', '1919810', '集成人物', ['整理后的摘要']);

  const legacyPath = path.join(dataDir, 'memory', 'backups', 'group_456', '1919810.json');
  assert.ok(fs.existsSync(legacyPath), 'replaceMember must protect the actual consolidation write path');
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyPath, 'utf8')), before);

  const after = memory.getMember('', '1919810');
  assert.deepEqual(after.impressions.map((entry) => entry.content), ['整理后的摘要']);
});

test('name-only / 非数字 id 成员同样拿到可回滚快照（2026-09-24 审查补的盲区）', () => {
  // 原来 backupPersonBeforeConsolidation 对非数字 uid 一律返回 null：
  // remove/clearSource/clearPersonSource 删这类成员时拍不到快照，删了就回不来。
  const nameOnly = {
    version: 2,
    userId: '',
    name: '只有名字的群友',
    impressions: [
      { content: 'name-only 印象', createdAt: 100, lastObservedAt: 100, sourceChatKeys: ['group:456'] }
    ],
    sourceChatKeys: ['group:456'],
    updatedAt: 100,
    lastConsolidatedAt: 0
  };
  const file = backupPersonBeforeConsolidation(nameOnly, { sourceChatKey: 'group:456', at: 3000 });
  assert.ok(file, 'name-only 成员的删除必须能拿到快照');
  // 快照目录键与成员文件名同源：_n_<净化名字>
  assert.match(file, /[\\/]_n_只有名字的群友[\\/]/);
  assert.ok(
    fs.existsSync(path.join(dataDir, 'memory', 'backups', 'group_456', '_n_只有名字的群友.json')),
    'legacy 路径同样保留 name-only 快照'
  );

  const oddId = {
    version: 2,
    userId: 'abc-123',
    name: '非常规 ID',
    impressions: [
      { content: 'u_ 印象', createdAt: 100, lastObservedAt: 100, sourceChatKeys: ['group:456'] }
    ],
    sourceChatKeys: ['group:456'],
    updatedAt: 100,
    lastConsolidatedAt: 0
  };
  const file2 = backupPersonBeforeConsolidation(oddId, { sourceChatKey: 'group:456', at: 4000 });
  assert.ok(file2, '非数字 id 的成员同样要有快照');
  assert.match(file2, /[\\/]u_abc_123[\\/]/);

  // 没有印象的对象照旧不落盘（返回 null）
  assert.equal(backupPersonBeforeConsolidation({
    version: 2, userId: '', name: '空印象', impressions: [], sourceChatKeys: [], updatedAt: 0, lastConsolidatedAt: 0
  }, { sourceChatKey: 'group:456', at: 5000 }), null);
});

test('first appearance in a new chat merges without creating a destructive-write backup', () => {
  const memory = new MemoryStore();
  memory.append('private:23333', 'memberImpression', '跨会话已有印象', {
    userId: '23333',
    target: '跨会话人物'
  });

  memory.replaceMember('group:999', '23333', '跨会话人物', ['新群提炼印象']);

  const legacyPath = path.join(dataDir, 'memory', 'backups', 'group_999', '23333.json');
  assert.equal(fs.existsSync(legacyPath), false, 'non-destructive first-source merge should not create a backup');
  const after = memory.getMember('', '23333');
  assert.deepEqual(
    new Set(after.impressions.map((entry) => entry.content)),
    new Set(['跨会话已有印象', '新群提炼印象'])
  );
});
