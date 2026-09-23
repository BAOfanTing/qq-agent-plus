import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-global-memory-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { MemoryStore } = await import('../src/memory/memory.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.memory.handoffEnabled = true;
cfg.memory.handoffTtlMinutes = 30;
setRuntimeConfig(cfg);

test('global person memory migration and isolation rules', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const memoryRoot = path.join(root, 'memory');
  fs.mkdirSync(path.join(memoryRoot, 'group_100'), { recursive: true });
  fs.mkdirSync(path.join(memoryRoot, 'private_12345'), { recursive: true });

  fs.writeFileSync(path.join(memoryRoot, 'group_100', '12345.json'), JSON.stringify({
    userId: '12345',
    name: 'Alice',
    impressions: [{ content: '喜欢 C++', createdAt: 100 }],
    updatedAt: 100,
    lastConsolidatedAt: 0
  }), 'utf8');
  fs.writeFileSync(path.join(memoryRoot, 'private_12345', '12345.json'), JSON.stringify({
    userId: '12345',
    name: 'Alice',
    impressions: [{ content: '正在准备面试', createdAt: 200 }],
    updatedAt: 200,
    lastConsolidatedAt: 0
  }), 'utf8');

  const memory = new MemoryStore();

  await t.test('merges the same QQ across group and private memory files', () => {
    const member = memory.getMember('group:999', '12345');
    assert.deepEqual(member.impressions.map((x) => x.content), ['喜欢 C++', '正在准备面试']);
    assert.deepEqual(new Set(member.sourceChatKeys), new Set(['group:100', 'private:12345']));
    assert.ok(fs.existsSync(path.join(memoryRoot, 'people', '12345.json')));
    assert.ok(!fs.existsSync(path.join(memoryRoot, 'group_100', '12345.json')));
    assert.ok(!fs.existsSync(path.join(memoryRoot, 'private_12345', '12345.json')));
    assert.ok(fs.existsSync(path.join(memoryRoot, 'backups', 'global-people-v1', 'group_100', '12345.json')));
  });

  await t.test('injects a person global memory in a chat where it was never created', () => {
    const prompt = memory.formatForPrompt('group:999', { userIds: ['12345'] });
    assert.match(prompt, /【对群友的全局印象】/);
    assert.match(prompt, /喜欢 C\+\+/);
    assert.match(prompt, /正在准备面试/);

    memory.append('group:200', 'memberImpression', '爱玩烂梗', {
      userId: '12345',
      target: 'Alice'
    });
    assert.match(memory.formatForPrompt('group:100', { userIds: ['12345'] }), /爱玩烂梗/);
  });

  await t.test('管理员本人的印象要点明身份（否则模型会当成外人在试探它）', () => {
    const ownerCfg = structuredClone(DEFAULT_CONFIG);
    ownerCfg.admin = { ...(ownerCfg.admin || {}), ownerUin: '1950000001' };
    ownerCfg.memory.handoffEnabled = true;
    setRuntimeConfig(ownerCfg);
    memory.append('group:999', 'memberImpression', '爱问"你现在是什么人设"，也爱逗人表演', {
      userId: '1950000001',
      target: '瓦力瓦力哇'
    });
    const ownerLine = memory.formatForPrompt('group:999', { userIds: ['1950000001'] });
    assert.match(ownerLine, /瓦力瓦力哇（QQ 1950000001，就是管理员本人）/, `管理员那条要点明身份：${ownerLine}`);
    // 别人不能被误标成管理员
    assert.doesNotMatch(memory.formatForPrompt('group:999', { userIds: ['12345'] }), /就是管理员本人/);
    setRuntimeConfig(cfg);
  });

  await t.test('整理写回：内容没变的条目沿用旧时间戳，新条目才用 now', () => {
    const oldAt = Date.now() - 60 * 24 * 3600 * 1000;   // 六十天前
    const peopleDir = path.join(root, 'memory', 'people');
    fs.mkdirSync(peopleDir, { recursive: true });
    fs.writeFileSync(path.join(peopleDir, '13579.json'), JSON.stringify({
      version: 2,
      userId: '13579',
      name: 'Dave',
      sourceChatKeys: ['group:700'],
      impressions: [{ content: '六十天前的老印象', createdAt: oldAt, lastObservedAt: oldAt, sourceChatKeys: ['group:700'] }]
    }), 'utf8');
    const fresh = new MemoryStore();
    fresh.replaceMember('group:700', '13579', 'Dave', ['六十天前的老印象', '这次新写的一条']);
    const impressions = fresh.getMember('group:700', '13579').impressions;
    const kept = impressions.find((e) => e.content === '六十天前的老印象');
    const added = impressions.find((e) => e.content === '这次新写的一条');
    // 以前这里一律赋 now：每次整理都把年龄刷成当天，日期前缀与"90 天衰减"全成自指
    assert.equal(kept.createdAt, oldAt, '内容没变的条目要保留原 createdAt');
    assert.equal(kept.lastObservedAt, oldAt, '也不该刷新 lastObservedAt');
    assert.ok(added.createdAt > oldAt, '新写的条目才用 now');
  });

  await t.test('印象来源（origin）：模型记的 / 整理改写 / 手动编辑分得开', () => {
    memory.append('group:900', 'memberImpression', '模型自己记的一条', { userId: '97531', target: 'Eve' });
    const appended = () => memory.getMember('group:900', '97531').impressions;
    assert.equal(appended().find((e) => e.content === '模型自己记的一条')?.origin, 'model');

    memory.replaceMemberForConsolidation('group:900', '97531', 'Eve', ['模型自己记的一条', '整理新写的一条']);
    assert.equal(appended().find((e) => e.content === '模型自己记的一条')?.origin, 'model', '原样保留的条目来源不该被改成整理');
    assert.equal(appended().find((e) => e.content === '整理新写的一条')?.origin, 'consolidated');

    memory.editMemberImpression('group:900', { userId: '97531', name: 'Eve', impressions: ['手动写的一条'] });
    assert.equal(appended()[0]?.origin, 'manual', '控制台手改的要标成 manual');
  });

  await t.test('来源能穿过子类透传到存储层（曾经在 replaceMember 少写形参处静默丢掉）', () => {
    // 走真实实例（memory.js 的子类）→ memory-global → 存储层，端到端确认 options 没丢
    memory.replaceMember('group:910', '86420', 'Frank', ['人手改的一条'], { origin: 'manual' });
    assert.equal(
      memory.getMember('group:910', '86420').impressions[0]?.origin,
      'manual',
      'replaceMember 的第 5 个参数必须透传'
    );
    memory.replaceMember('group:910', '86420', 'Frank', ['整理写的一条']);
    assert.equal(memory.getMember('group:910', '86420').impressions[0]?.origin, 'consolidated', '不传时按整理默认');
    // 控制台"新增印象"走 append，也要能标 manual
    memory.append('group:910', 'memberImpression', '手加的一条', { userId: '86420', target: 'Frank', origin: 'manual' });
    assert.equal(
      memory.getMember('group:910', '86420').impressions.find((e) => e.content === '手加的一条')?.origin,
      'manual'
    );
    // 模型自己记的仍然是 model
    memory.append('group:910', 'memberImpression', '模型记的一条', { userId: '86420', target: 'Frank' });
    assert.equal(
      memory.getMember('group:910', '86420').impressions.find((e) => e.content === '模型记的一条')?.origin,
      'model'
    );
  });

  await t.test('每条印象带日期（模型才能判断"这是昨天还是两周前"）', () => {
    const line = memory.formatForPrompt('group:999', { userIds: ['12345'] });
    assert.match(line, /- Alice：\[\d{2}-\d{2}\] /, `印象行要带 [MM-DD]：${line.split('\n')[1]}`);
  });

  await t.test('交接里的"已作决定/下一步"只约束同一话题（写进提示词）', async () => {
    const { buildSystemPrompt } = await import('../src/llm/prompt.js');
    const sp = buildSystemPrompt({});
    assert.match(sp, /只约束\*\*同一个话题\*\*|只约束同一个话题/, '缺"交接只约束同一话题"这条规则');
  });

  await t.test('does not erase old global memories when a known person is first consolidated in a new chat', () => {
    memory.append('group:400', 'memberImpression', '旧群里形成的长期印象', {
      userId: '24680',
      target: 'Carol'
    });
    memory.replaceMember('group:500', '24680', 'Carol', ['新群里新提炼的印象']);

    const member = memory.getMember('group:500', '24680');
    assert.deepEqual(
      member.impressions.map((x) => x.content),
      ['旧群里形成的长期印象', '新群里新提炼的印象']
    );
    assert.deepEqual(new Set(member.sourceChatKeys), new Set(['group:400', 'group:500']));
  });

  await t.test('keeps handoff state isolated by chatKey', () => {
    memory.setHandoff('group:100', { summary: '群里正在聊 A' });
    memory.setHandoff('private:12345', { summary: '私聊正在聊 B' });
    assert.match(memory.formatHandoffForPrompt('group:100'), /群里正在聊 A/);
    assert.doesNotMatch(memory.formatHandoffForPrompt('group:100'), /私聊正在聊 B/);
    assert.match(memory.formatHandoffForPrompt('private:12345'), /私聊正在聊 B/);
  });

  await t.test('clearing one source does not erase memories that still belong to another source', () => {
    memory.append('group:300', 'memberImpression', '只来自群300', {
      userId: '67890',
      target: 'Bob'
    });
    memory.append('private:67890', 'memberImpression', '只来自私聊', {
      userId: '67890',
      target: 'Bob'
    });

    memory.clear('group:300');
    const member = memory.getMember('private:67890', '67890');
    assert.deepEqual(member.impressions.map((x) => x.content), ['只来自私聊']);
    assert.equal(memory.getHandoff('group:300'), null);
  });
});
