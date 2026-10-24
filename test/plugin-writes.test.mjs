// 插件写操作信任模型（v2.1）：开关默认关 → 对象级批准（待批队列）→ 60s 间隔 → 配额，
// 以及"确定未执行"的批准/配额退还。全部宿主侧，用假 host（不起子进程）验注册表的完整链路。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-writes-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } });

const {
  grantApproval, checkApproval, refundApproval, consumeQuota, refundQuota,
  requestPendingApproval, listPendingApprovals, approvePendingApproval,
  rejectPendingApproval, recordPluginWrite, listPluginWrites
} = await import('../src/plugins/grants.js');
const { PluginRegistry, PLUGIN_WRITE_FLOOR_MS } = await import('../src/plugins/registry.js');

const manifest = () => ({
  id: 'demo',
  apiVersion: 2,
  name: '演示写插件',
  version: '1.0.0',
  capabilities: ['tools'],
  tools: [{
    name: 'do',
    description: '写一点东西',
    parameters: { type: 'object', properties: { bvid: { type: 'string' } }, required: ['bvid'] },
    action: 'write',
    actionTarget: ['bvid'],
    actionPreview: 'text'
  }],
  approvals: [{ action: 'write', label: '写', description: '会写', defaultUses: 1 }],
  quotas: { write: 10 }
});

function makeRegistry({ switchOn = true, ownerUin = '', behavior = {}, manifestPatch = null } = {}) {
  const base = manifest();
  const m = manifestPatch ? { ...base, ...manifestPatch } : base;
  const calls = [];
  const host = {
    id: m.id,
    manifest: m,
    state: 'running',
    lastError: '',
    startedAt: Date.now(),
    callTool: async (name, args, { context } = {}) => {
      calls.push({ name, args, context });
      if (behavior.throw) {
        const error = new Error(behavior.throw);
        if (behavior.throwCode) error.code = behavior.throwCode;
        throw error;
      }
      return { ok: true, verified: true, echo: args.bvid, approved: context?.approved || null };
    },
    status: () => ({ id: m.id, state: 'running', running: true, stats: {} }),
    stop: async () => {},
    observe: () => false
  };
  const registry = new PluginRegistry({
    root: path.join(dataDir, 'plugins'),
    dataDir,
    log: () => {},
    getConfig: () => ({
      admin: ownerUin ? { ownerUin } : undefined,
      plugins: {
        enabled: true,
        enabledIds: ['demo'],
        lazy: true,
        requireIsolation: false,
        switches: switchOn ? { demo: { write: true } } : {}
      }
    }),
    getSender: () => null,
    hostFactory: () => host
  });
  registry.hosts.set('demo', host);
  return { registry, host, calls };
}

const runTool = async (registry, args) => {
  const meta = registry.toolDefsFor().find((t) => t.name === 'plugin_call');
  return meta.execute({ chatKey: 'group:1' }, { tool: 'demo__do', args });
};

const parse = (result) => JSON.parse(result.content);

test('对象级授权：一次批准只对一个目标', () => {
  grantApproval(dataDir, 'demo', 'write', { target: 'BV1', uses: 1, ttlMs: 60_000 });
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BV1' }).approved, true, '同目标放行');
  const other = checkApproval(dataDir, 'demo', 'write', { target: 'BV2' });
  assert.equal(other.approved, false);
  assert.match(other.reason, /只对一个目标/);
  // 通配（target 空）匹配任意目标 —— 兼容插件直调 cap.approval.check 的旧路径
  grantApproval(dataDir, 'demo', 'wild', { target: '', uses: 1, ttlMs: 60_000 });
  assert.equal(checkApproval(dataDir, 'demo', 'wild', { target: 'ANY' }).approved, true);
});

test('待批队列：请求 → 私聊/控制台批准 → 单次通行证；拒绝即消失', () => {
  const pending = requestPendingApproval(dataDir, {
    pluginId: 'demo', pluginName: '演示', action: 'write', label: '写', target: 'BV9', preview: 'hello'
  });
  assert.match(pending.id, /^ap_/);
  assert.equal(pending.duplicate, undefined);
  const dup = requestPendingApproval(dataDir, {
    pluginId: 'demo', action: 'write', target: 'BV9', preview: 'hello'
  });
  assert.equal(dup.duplicate, true, '同目标重复请求只留一条');

  const approved = approvePendingApproval(dataDir, pending.id, { uses: 1, ttlMs: 60_000 });
  assert.equal(approved.pending.target, 'BV9');
  assert.equal(approved.grant.target, 'BV9');
  assert.equal(listPendingApprovals(dataDir).some((item) => item.id === pending.id), false, '批准后出队');

  const consumed = checkApproval(dataDir, 'demo', 'write', { consume: true, target: 'BV9', preview: 'hello' });
  assert.equal(consumed.approved, true);
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BV9', preview: 'hello' }).approved, false, '一次用完');
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BV9', preview: '换了一段' }).approved, false,
    '批准绑定预览内容：换了正文必须重新批准');

  const p2 = requestPendingApproval(dataDir, { pluginId: 'demo', action: 'write', target: 'BV8' });
  rejectPendingApproval(dataDir, p2.id);
  assert.equal(listPendingApprovals(dataDir).length, 0);
  assert.throws(() => approvePendingApproval(dataDir, p2.id), /不存在或已过期/);
});

test('退还：确定未执行退回批准与配额，且幂等', () => {
  grantApproval(dataDir, 'demo', 'write', { target: 'BVR', uses: 1, ttlMs: 60_000 });
  const approval = checkApproval(dataDir, 'demo', 'write', { consume: true, target: 'BVR' });
  const quota = consumeQuota(dataDir, 'demo', 'write', 2);
  assert.equal(quota.ok, true);
  assert.equal(refundApproval(dataDir, 'demo', approval.receipt), true);
  assert.equal(refundApproval(dataDir, 'demo', approval.receipt), false, '收据只退一次');
  assert.equal(refundQuota(dataDir, 'demo', quota.receipt), true);
  assert.equal(refundQuota(dataDir, 'demo', quota.receipt), false);
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BVR' }).approved, true, '批准回来了');
  assert.equal(consumeQuota(dataDir, 'demo', 'write', 2).used, 1, '配额退回到 1（原扣 2 退 1）');
});

test('写审计：宿主侧记录，最近在前，超过上限裁剪', () => {
  recordPluginWrite(dataDir, 'audit', { action: 'write', target: 'A', outcome: 'ok', note: '回读核验通过' });
  recordPluginWrite(dataDir, 'audit', { action: 'write', target: 'B', outcome: 'pending', note: 'ap_x' });
  const writes = listPluginWrites(dataDir, 'audit');
  assert.equal(writes[0].target, 'B');
  assert.equal(writes[1].outcome, 'ok');
});

test('注册表全链路：开关隐藏工具 → 未批生成待批 → 批准后执行 → 单次耗尽', async () => {
  // ① 开关关：工具不注册（模型看不见）
  const off = makeRegistry({ switchOn: false });
  assert.equal(off.registry.toolDefsFor().length, 0, '开关关时 plugin_call 都不该出现');

  // ② 开关开、未批：报 needsApproval、生成待批、审计记 pending
  const { registry } = makeRegistry({ ownerUin: '10001' });
  const denied = parse(await runTool(registry, { bvid: 'BVZ', text: '内容' }));
  assert.equal(denied.needsApproval, true);
  assert.match(denied.error, /需要管理员批准/);
  const pending = listPendingApprovals(dataDir).find((item) => item.pluginId === 'demo' && item.target === 'BVZ');
  assert.ok(pending, '待批已登记');
  assert.equal(pending.preview, '内容', 'actionPreview 参数进了待批预览');
  assert.equal(listPluginWrites(dataDir, 'demo')[0].outcome, 'pending');

  // ③ 私聊同意：只有 owner 本人、且消息就是"同意/拒绝"
  const stranger = registry.handleOwnerApprovalText('同意', '99999');
  assert.equal(stranger.handled, false, '非 owner 不拦消息');
  const chat = registry.handleOwnerApprovalText('同意', '10001');
  assert.equal(chat.handled, true);
  assert.match(chat.reply, /已批准/);

  // ④ 批准后重试：执行成功，插件拿到 approved 标记，审计记 ok，配额扣 1
  const ok = parse(await runTool(registry, { bvid: 'BVZ', text: '内容' }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.approved, { action: 'write', target: 'BVZ' });
  const writes = listPluginWrites(dataDir, 'demo');
  assert.equal(writes[0].outcome, 'ok');
  assert.match(writes[0].note, /回读核验通过/);

  // ⑤ 单次通行证已耗尽：再调回到"待批"（先把间隔下限拨开，别让 60s 抢戏）
  registry.lastWriteAt.set('demo', Date.now() - PLUGIN_WRITE_FLOOR_MS - 1000);
  const again = parse(await runTool(registry, { bvid: 'BVZ', text: '内容' }));
  assert.equal(again.needsApproval, true);
});

test('注册表：60s 写入间隔下限 与 失败退还', async () => {
  const { registry, calls } = makeRegistry({ behavior: {} });
  grantApproval(dataDir, 'demo', 'write', { target: 'BVF', preview: '内容', uses: 5, ttlMs: 60_000 });

  const first = parse(await runTool(registry, { bvid: 'BVF', text: '内容' }));
  assert.equal(first.ok, true);

  // 间隔下限：手动把 lastWriteAt 拨到"刚写过"，第二次同插件写被拒
  const saved = registry.lastWriteAt.get('demo');
  registry.lastWriteAt.set('demo', Date.now());
  const floored = parse(await runTool(registry, { bvid: 'BVF', text: '内容' }));
  assert.match(floored.error, /至少间隔/);
  assert.equal(calls.length, 1, '被间隔挡住的调用不该到达插件');
  registry.lastWriteAt.set('demo', saved - PLUGIN_WRITE_FLOOR_MS);

  // 失败退还：插件抛错 → 批准与配额都退回去
  const failing = makeRegistry({ behavior: { throw: 'B 站接口挂了' } });
  failing.registry.lastWriteAt.set('demo', Date.now() - PLUGIN_WRITE_FLOOR_MS - 1000);
  grantApproval(dataDir, 'demo', 'write', { target: 'BVE', preview: '内容', uses: 1, ttlMs: 60_000 });
  const err = parse(await runTool(failing.registry, { bvid: 'BVE', text: '内容' }));
  assert.equal(err.error.includes('B 站接口挂了'), true);
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BVE', preview: '内容' }).approved, true, '抛错后批准已退还');
});

test('聊天内拒绝：owner 回「拒绝」出队并回话', async () => {
  // 前面用例可能留了未消费的待批（比如"耗尽后再调"那条）：先清场，别让它抢走"最新一条"
  for (const leftover of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, leftover.id);
  const { registry } = makeRegistry({ ownerUin: '10001' });
  await runTool(registry, { bvid: 'BVRJ', text: '拒绝测试' });
  const chat = registry.handleOwnerApprovalText('拒绝', '10001');
  assert.equal(chat.handled, true);
  assert.match(chat.reply, /已拒绝/);
  assert.equal(listPendingApprovals(dataDir).some((item) => item.target === 'BVRJ'), false);
  const empty = registry.handleOwnerApprovalText('同意', '10001');
  assert.equal(empty.handled, true);
  assert.match(empty.reply, /没有待批准/);
});

test('目标缺失/非法：拒绝且不生成通配批准（旧实现会退化成 target:"" 万能通行证）', async () => {
  for (const leftover of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, leftover.id);
  const { registry, calls } = makeRegistry({ behavior: {} });
  const missing = parse(await runTool(registry, { text: '内容' }));
  assert.equal(missing.needsApproval, false);
  assert.match(missing.error, /需要明确目标/);
  const bad = parse(await runTool(registry, { bvid: 'BV/../x', text: '内容' }));
  assert.match(bad.error, /目标不合法/);
  assert.equal(calls.length, 0, '两种情况都不该到达插件');
  assert.equal(listPendingApprovals(dataDir).length, 0, '不许生成"无目标"待批');
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'ANYTHING', preview: '内容' }).approved, false,
    '更不许出现任意目标都能命中的通行证');
});

test('预览内容改变：旧批准失效，并为新内容单独生成待批', async () => {
  for (const leftover of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, leftover.id);
  const { registry } = makeRegistry({ ownerUin: '10001' });
  registry.lastWriteAt.set('demo', 0);
  await runTool(registry, { bvid: 'BVP', text: '好评' });
  const pending = listPendingApprovals(dataDir).find((item) => item.target === 'BVP');
  assert.ok(pending, '第一次请求生成待批');
  registry.handleOwnerApprovalText(`同意 ${pending.id}`, '10001');

  const same = parse(await runTool(registry, { bvid: 'BVP', text: '好评' }));
  assert.equal(same.ok, true, '批准过的同一段内容可以执行');

  registry.lastWriteAt.set('demo', Date.now() - PLUGIN_WRITE_FLOOR_MS - 1000);
  const changed = parse(await runTool(registry, { bvid: 'BVP', text: '恶意内容' }));
  assert.equal(changed.needsApproval, true, '换了正文必须重新批准');
  const pending2 = listPendingApprovals(dataDir).find((item) => item.target === 'BVP' && item.preview === '恶意内容');
  assert.ok(pending2, '新内容要有自己的待批（不能复用旧文案的待批）');
});

test('一次调用给了多个不同目标：拒绝（否则批准对象与实际执行参数会错位）', async () => {
  for (const leftover of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, leftover.id);
  const tools = [{
    ...manifest().tools[0],
    parameters: { type: 'object', properties: { bvid: { type: 'string' }, mid: { type: 'string' } } },
    actionTarget: ['bvid', 'mid']
  }];
  const { registry, calls } = makeRegistry({ behavior: {}, manifestPatch: { tools } });
  const both = parse(await runTool(registry, { bvid: 'BV1', mid: '12345', text: '内容' }));
  assert.match(both.error, /多个不同的目标/);
  assert.equal(calls.length, 0, '有歧义的调用不该到达插件');

  // 只给一个目标时按它绑定（follow 用 mid、like 用 bvid 都走这条路）
  const one = parse(await runTool(registry, { mid: '12345', text: '内容' }));
  assert.equal(one.needsApproval, true);
  assert.equal(listPendingApprovals(dataDir).find((item) => item.target === '12345')?.action, 'write');
});

test('超时/进程退出：结果未知 → 不退批准与配额，并明确不重试', async () => {
  const failing = makeRegistry({ behavior: { throw: 'request timeout', throwCode: 'E_TIMEOUT' } });
  failing.registry.lastWriteAt.set('demo', 0);
  grantApproval(dataDir, 'demo', 'write', { target: 'BVT', preview: '内容', uses: 1, ttlMs: 60_000 });
  const res = parse(await runTool(failing.registry, { bvid: 'BVT', text: '内容' }));
  assert.equal(res.uncertain, true);
  assert.match(res.error, /不要重试/);
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BVT', preview: '内容' }).approved, false,
    '结果未知不能退还批准（否则模型重试 = 重复评论）');
  assert.equal(listPluginWrites(dataDir, 'demo')[0].outcome, 'unknown');
});
