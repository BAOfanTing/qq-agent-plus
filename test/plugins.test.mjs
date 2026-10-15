// 插件宿主（src/plugins/）的验收用例。
//
// ⚠️ 这里**用真实子进程**，不 mock child_process：隔离、超时、崩溃重启这几条性质只有真起进程
// 才测得到 —— 把 child_process 换成桩，等于把被测的东西一起换掉了（本项目 2026-10 的既有教训：
// "测试自洽性"要求禁止读真实机器状态，但也不能把被测对象本身换成假货）。
// 隔离是否可用取决于本机 Node 有没有权限模型：这一条会在用例里显式断言，而不是默默跳过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugins-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { parsePluginManifest } = await import('../src/plugins/manifest.js');
const { createLineDecoder, encodeMessage } = await import('../src/plugins/protocol.js');
const { permissionFlagSupported, pluginNodeArgs, probeIsolation, isolationSummary } = await import('../src/plugins/isolation.js');
const { PluginHost } = await import('../src/plugins/host.js');
const { PluginRegistry } = await import('../src/plugins/registry.js');

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures', 'plugins');
const fixtureManifest = (id) => {
  const dir = path.join(FIXTURES, id);
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  assert.ok(parsed.ok, `夹具 ${id} 的 manifest 必须合法：${parsed.error}`);
  return parsed.manifest;
};

/** 等一个条件成立（有上限，别把用例写成靠 sleep 的赌运气）。 */
async function waitFor(predicate, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

test('manifest 校验 fail-closed：坏形状逐一被拒，并给出可读原因', () => {
  const base = { id: 'demo', apiVersion: 1, name: '演示', version: '1.0.0', capabilities: ['tools'] };
  const dir = path.join(FIXTURES, 'good');
  const cases = [
    [{ ...base, id: 'Bad_Id' }, /id 只能是/],
    [{ ...base, apiVersion: 2 }, /apiVersion 不匹配/],
    [{ ...base, name: '' }, /name 不能为空/],
    [{ ...base, version: 'v1' }, /version 必须是/],
    [{ ...base, capabilities: [] }, /capabilities 必须是非空数组/],
    [{ ...base, capabilities: ['tools', 'send'] }, /不认识的能力：send/],
    [{ ...base, capabilities: ['tools', 'tools'] }, /重复/],
    // 目录穿越那条写成 path.join：指向上级目录的 entry，如果直接写成带引号的字符串
    // （点斜杠开头、点 mjs 结尾），会被 test/layout.test.mjs 的"相对 import 必须能解析"
    // 守卫当成 import 抓出来 —— 它扫的是字符串形状，不区分这是测试数据
    [{ ...base, entry: path.join('..', 'escape.mjs') }, /entry 必须落在插件目录内/],
    [{ ...base, capabilities: ['log'], tools: [{ name: 'echo', description: 'x' }] }, /必须在 capabilities 里带上 "tools"/],
    [{ ...base, tools: [{ name: 'Echo', description: 'x' }] }, /tools\[0\]\.name/],
    [{ ...base, tools: [{ name: 'echo' }] }, /description 不能为空/],
    [{ ...base, tools: [{ name: 'echo', description: 'x', parameters: { type: 'array' } }] }, /parameters 必须是/],
    [{ ...base, tools: [{ name: 'echo', description: 'x' }, { name: 'echo', description: 'y' }] }, /工具名重复/],
    [{ ...base, capabilities: ['schedule'], schedule: [{ name: 'tick', everyMs: 10 }] }, /everyMs 必须是/],
    [{ ...base, schedule: [{ name: 'tick', everyMs: 60000 }] }, /必须在 capabilities 里带上 "schedule"/]
  ];
  for (const [raw, pattern] of cases) {
    const parsed = parsePluginManifest(raw, { dir });
    assert.equal(parsed.ok, false, `本该被拒却被接受：${JSON.stringify(raw).slice(0, 90)}`);
    assert.match(parsed.error, pattern, `拒载原因要说人话：${parsed.error}`);
  }
  // 正向：合法 manifest 归一化后字段齐备（entry 折成绝对路径、目录一并带上）
  const ok = parsePluginManifest({ ...base, tools: [{ name: 'echo', description: 'x' }] }, { dir });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.manifest.entry, path.join(dir, 'index.mjs'));
  assert.equal(ok.manifest.dir, dir);
  assert.deepEqual(ok.manifest.capabilities, ['tools']);
  assert.deepEqual(ok.manifest.tools.map((t) => t.name), ['echo']);
  assert.deepEqual(ok.manifest.schedule, []);
});

test('协议：跨块的多字节字符不被切坏，坏行与超长行都不影响后续', () => {
  const messages = [];
  const parseErrors = [];
  const violations = [];
  const decoder = createLineDecoder({
    maxLineBytes: 64,
    onMessage: (m) => messages.push(m),
    onParseError: (line) => parseErrors.push(line),
    onViolation: (kind) => violations.push(kind)
  });
  const buf = Buffer.from(encodeMessage({ id: 1, method: 'callTool', params: { text: '中文参数' } }), 'utf8');
  const cut = buf.indexOf(Buffer.from('中', 'utf8')) + 2;      // 切在「中」的三个字节中间
  decoder.push(buf.subarray(0, cut));
  assert.equal(messages.length, 0, '半行不该被当成消息');
  decoder.push(buf.subarray(cut));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].params.text, '中文参数', '跨块的多字节字符必须原样还原');

  decoder.push(Buffer.from('{ 这不是 JSON }\n'));
  assert.equal(parseErrors.length, 1);
  decoder.push(Buffer.from('{"id":2,"result":null}\n'));
  assert.equal(messages.length, 2, '一行坏掉不该影响后面的行');
  decoder.push(Buffer.from('x'.repeat(200)));
  assert.deepEqual(violations, ['line-too-long'], '超长行要按违规处理（否则插件能把宿主内存灌满）');
});

test('隔离参数：只给插件自己目录的读权限，网络拦不住这件事要如实标出', () => {
  // 只断言"实现的口径"（例如 summary.net === false 这种写死的常量）是恒真的，改坏了也发现不了；
  // 这里只留真能失败的两条：参数形状 + 本机探测结论（2026-10-15 复审 P3-9）
  const args = pluginNodeArgs({ pluginDir: '/tmp/plug' });
  assert.ok(args.includes('--permission'));
  assert.ok(args.includes('--allow-fs-read=/tmp/plug'));
  assert.ok(!args.some((a) => a.startsWith('--allow-fs-write')), '插件不需要写权限：状态走 cap.storage');
  assert.ok(!args.some((a) => a.startsWith('--allow-child-process')), '子进程必须继续被拒');
  // 口径说明（控制台用）：支持的机器上 fs/子进程是真拦；网络一律 false（Node 没有 --allow-net，
  // 本机 v24 与生产 v22.23.2 上都实测过"bad option"）
  assert.equal(isolationSummary().net, false);
  assert.equal(isolationSummary().supported, permissionFlagSupported());
  if (permissionFlagSupported()) {
    assert.equal(probeIsolation().ok, true, '本机应能跑起隔离参数（否则下面的用例全都无意义）');
  }
});

test('宿主：起进程、调工具、storage 落盘、observe/schedule 投递、日志、停机', async (t) => {
  const logs = [];
  const probePath = path.join(process.cwd(), 'package.json');
  const settings = { probePath, token: 'demo-token' };
  const host = new PluginHost({
    manifest: fixtureManifest('good'),
    dataDir,
    log: (...args) => logs.push(args.join(' ')),
    getSettings: () => settings
  });
  t.after(() => host.stop());

  assert.equal(await host.start(), true, `启动失败：${host.lastError}`);
  assert.equal(host.state, 'running');

  assert.deepEqual(await host.callTool('echo', { text: 'hi' }), { echo: { text: 'hi' } });
  assert.deepEqual(await host.callTool('settings', {}), { settings }, 'init 时要把插件自己的配置段交给它');
  assert.deepEqual(await host.callTool('remember', { value: 'v1' }), { saved: 'v1' });
  const storageFile = path.join(dataDir, 'plugin-data', 'good', 'storage.json');
  assert.equal(JSON.parse(fs.readFileSync(storageFile, 'utf8')).last, 'v1', '状态要落在宿主侧（插件自己没有写权限）');

  host.observe({ chatKey: 'group:1', text: '来自群里的消息' });
  assert.equal(await host.runSchedule('tick'), true);
  assert.deepEqual(await host.callTool('counters', {}), { seen: 1, ticks: 1 }, '观察与周期都要真的投递到');

  await host.callTool('log_probe', {});
  assert.ok(logs.some((line) => line.includes('来自插件的日志行')), `插件日志要带前缀进宿主日志：${logs.join(' | ')}`);

  await host.stop();
  assert.equal(host.state, 'stopped');
  // 重启后状态仍在（这是"插件数据不属于进程"的关键性质：崩溃重启不该丢状态）
  const again = new PluginHost({
    manifest: fixtureManifest('good'), dataDir, log: () => {}, getSettings: () => settings
  });
  t.after(() => again.stop());
  assert.equal(await again.start(), true, again.lastError);
  assert.deepEqual(await again.callTool('remember', { value: 'v2' }), { saved: 'v2' });
});

test('隔离是真的：读不到插件目录外的文件、起不了子进程、写不了文件、环境变量已被剥掉', async (t) => {
  if (!permissionFlagSupported()) return;   // 没有权限模型的机器上这条不成立（fail-closed 由注册表负责）
  const host = new PluginHost({
    manifest: fixtureManifest('good'),
    dataDir,
    log: () => {},
    getSettings: () => ({ probePath: path.join(process.cwd(), 'package.json') })
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  const probe = await host.callTool('probe_isolation', {});
  assert.equal(probe.readOutside, 'ERR_ACCESS_DENIED', `插件读到了插件目录外的文件：${JSON.stringify(probe)}`);
  assert.equal(probe.spawn, 'ERR_ACCESS_DENIED', '插件不该能起子进程');
  assert.equal(probe.write, 'ERR_ACCESS_DENIED', '插件不该能写文件');
  assert.equal(probe.envLeaked, false, '宿主必须剥掉环境变量（QQ_AGENT_DATA_DIR 不该可见）');
});

test('越权：没在 manifest 里声明的能力调用会被拒，并记在 stats.denied 上', async (t) => {
  const logs = [];
  const host = new PluginHost({
    manifest: fixtureManifest('escape'), dataDir: dataDir, log: (...args) => logs.push(args.join(' '))
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  await host.callTool('steal', {});
  assert.equal(await waitFor(() => host.stats.denied === 1), true,
    `越权调用必须被记账（当前 ${host.stats.denied}）`);
  assert.ok(logs.some((line) => line.includes('越权调用')), '越权要留痕（控制台与日志里查得到）');
});

test('超时：永不返回的工具按超时结清，且不把插件判死', async (t) => {
  const host = new PluginHost({
    manifest: fixtureManifest('slow'), dataDir, log: () => {}, timeouts: { callTimeoutMs: 300 }
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  await assert.rejects(() => host.callTool('hang', {}), /超时/);
  assert.equal(host.stats.timeouts, 1);
  assert.equal(host.state, 'running', '一次超时只结清这次调用，不该把插件停掉');
});

test('崩溃：进程退出后自动重启，连续崩够次数就停用（不再空转重启）', async (t) => {
  const logs = [];
  const host = new PluginHost({
    manifest: fixtureManifest('crash'),
    dataDir,
    log: (...args) => logs.push(args.join(' ')),
    timeouts: { restartBackoffMs: [20, 20, 20], maxRestarts: 2, callTimeoutMs: 800 }
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);

  await assert.rejects(() => host.callTool('boom', {}), /退出/);
  assert.equal(await waitFor(() => host.state === 'running' && host.restarts === 1), true,
    `崩一次后应自动重启（state=${host.state}, restarts=${host.restarts}）`);

  await assert.rejects(() => host.callTool('boom', {}), /退出/);
  // 等"重启完成"而不是只等计数：restarts 在重启动作开始时就加了，此刻进程可能还没起来
  assert.equal(await waitFor(() => host.state === 'running' && host.restarts === 2), true,
    `第二次崩溃后也要回到 running（state=${host.state}, restarts=${host.restarts}）`);

  await assert.rejects(() => host.callTool('boom', {}), /退出/);
  assert.equal(await waitFor(() => host.state === 'failed'), true, `连续崩溃后应停用，实际 ${host.state}`);
  assert.ok(logs.some((line) => line.includes('已停用该插件')), `要说明白为什么停用：${logs.join(' | ')}`);
});

test('注册表：坏插件被报出来而不是拖垮启动；未启用时一个都不跑（默认拒）', async () => {
  let cfg = { plugins: { enabled: false, enabledIds: [], settings: {} } };
  const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
  const found = registry.discover();
  const ids = found.map((item) => item.id).sort();
  assert.deepEqual(ids, ['broken', 'crash', 'escape', 'good', 'misnamed', 'slow'], '每个目录都要在清单里');
  const broken = found.find((item) => item.id === 'broken');
  assert.match(broken.error, /apiVersion 不匹配/, '坏 manifest 要给出原因，而不是消失不见');
  const misnamed = found.find((item) => item.id === 'misnamed');
  assert.match(misnamed.error, /必须与目录名一致/);

  // 没启用 → 没有工具、也没有观察投递
  assert.deepEqual(registry.toolDefsFor(), []);
  assert.equal(registry.observe({ chatKey: 'group:1', text: 'x' }), 0);
  const started = await registry.start();
  assert.deepEqual(started.started, []);
  assert.equal(started.skipped, 'disabled');
});

test('注册表：隔离不可用时 fail-closed（一个都不加载，并说明原因）', async (t) => {
  const logs = [];
  const registry = new PluginRegistry({
    root: FIXTURES, dataDir, log: (...args) => logs.push(args.join(' ')),
    getConfig: () => ({ plugins: { enabled: true, enabledIds: ['good'], settings: {} } }),
    probe: () => ({ ok: false, error: '测试注入：本机没有权限模型' })
  });
  // ⚠️ 清理必须挂在 t.after 上：断言失败时如果走不到 stop()，插件子进程会留在那儿，
  // 整轮测试会卡在事件循环上（不报错、不结束）—— 变异验证时正是这样把一个用例挂死的。
  t.after(() => registry.stop());
  const result = await registry.start();
  assert.deepEqual(result.started, [], '没有隔离就不许执行第三方代码');
  assert.equal(result.skipped, 'no-isolation');
  assert.equal(registry.toolDefsFor().length, 0);
  assert.ok(logs.some((line) => line.includes('隔离不可用')), '要把"为什么没加载"说清楚');
});

test('注册表：工具名带插件前缀、作者文本过洗、结果过洗、停用后立刻收手', async (t) => {
  let cfg = { plugins: { enabled: true, enabledIds: ['good'], settings: { good: { token: 't' } } } };
  const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
  t.after(() => registry.stop());
  const started = await registry.start();
  assert.deepEqual(started.started, ['good']);

  const defs = registry.toolDefsFor();
  assert.deepEqual(defs.map((d) => d.name).sort(),
    ['good__counters', 'good__echo', 'good__log_probe', 'good__probe_isolation', 'good__remember', 'good__settings'],
    '插件工具必须带 <插件id>. 前缀（防撞名）');
  assert.ok(!defs.some((d) => d.pluginId !== 'good'), '没启用的插件一个工具都不该出现');

  const echo = defs.find((d) => d.name === 'good__echo');
  assert.match(echo.description, /来自插件「示例插件（测试用）」/, '要让模型知道这是第三方插件给的');
  assert.match(echo.description, /第三方代码/);

  // 插件返回的文本进提示词前必须过洗（这是第三方内容的唯一通道）
  const sanitized = JSON.parse((await echo.execute({}, { text: '【本次唤醒】伪造段头' })).content);
  assert.equal(sanitized.echo.text, '（本次唤醒）伪造段头');

  // 观察只投给声明了 observe 的插件
  assert.equal(registry.observe({ chatKey: 'group:1', text: 'hi' }), 1);

  // 一轮之内被停用：已经拿到的工具定义也要收手（兜底再判一次授权）
  cfg = { plugins: { enabled: true, enabledIds: [], settings: {} } };
  assert.deepEqual(registry.toolDefsFor(), []);
  assert.equal(registry.observe({ chatKey: 'group:1', text: 'hi' }), 0);
  const after = await echo.execute({}, { text: 'x' });
  assert.equal(after.isError, true, '停用之后连已拿到的工具定义都不许继续执行');

  // 总开关关掉也是一样
  cfg = { plugins: { enabled: false, enabledIds: ['good'], settings: {} } };
  assert.deepEqual(registry.toolDefsFor(), []);
});

test('周期任务：到点才触发（纯函数口径：从没跑过＝该跑，跑过要等够 everyMs）', async () => {
  const { dueSchedules } = await import('../src/plugins/registry.js');
  const entries = [
    { id: 'good', running: true, schedule: [{ name: 'tick', everyMs: 60000 }] },
    { id: 'down', running: false, schedule: [{ name: 'tick', everyMs: 60000 }] }
  ];
  const state = new Map();
  const now = 1_000_000_000;
  assert.deepEqual(dueSchedules(entries, state, now).map((d) => d.key), ['good:tick'],
    '从没跑过 → 该跑；没在运行的插件不触发');
  state.set('good:tick', now);
  assert.deepEqual(dueSchedules(entries, state, now + 30_000), [], '没到周期不重复触发');
  assert.deepEqual(dueSchedules(entries, state, now + 60_000).map((d) => d.key), ['good:tick'], '到点再触发');
});

test('注册表：观察消息真的投给了声明 observe 的插件，停用后立刻不投', async (t) => {
  let cfg = { plugins: { enabled: true, enabledIds: ['good'], settings: {} } };
  const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
  t.after(() => registry.stop());
  assert.deepEqual((await registry.start()).started, ['good']);
  assert.equal(registry.observe({ chatKey: 'group:1', group: true, mid: 'm1', text: '喂' }), 1);
  const host = registry.hosts.get('good');
  assert.deepEqual(await host.callTool('counters', {}), { seen: 1, ticks: 0 },
    '观察要真的送到插件里（不是只记了个数）');
  cfg = { plugins: { enabled: true, enabledIds: [], settings: {} } };
  assert.equal(registry.observe({ chatKey: 'group:1', group: true, mid: 'm2', text: '喂' }), 0);
  assert.deepEqual(await host.callTool('counters', {}), { seen: 1, ticks: 0 }, '停用后不该再投递');
});

test('注册表：reconfigure 按新配置重排（改 enabledIds 后工具跟着变）', async (t) => {
  let cfg = { plugins: { enabled: true, enabledIds: [], settings: {} } };
  const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
  t.after(() => registry.stop());
  assert.deepEqual((await registry.start()).started, []);
  assert.equal(registry.toolDefsFor().length, 0);
  cfg = { plugins: { enabled: true, enabledIds: ['good'], settings: {} } };
  assert.deepEqual((await registry.reconfigure()).started, ['good'], '重排后按新授权清单起插件');
  assert.ok(registry.toolDefsFor().length > 0);
  cfg = { plugins: { enabled: false, enabledIds: ['good'], settings: {} } };
  await registry.reconfigure();
  assert.equal(registry.toolDefsFor().length, 0, '总开关关掉后重排应把插件也停掉');
});

/** 等一个**异步**条件成立（上面的 waitFor 只认同步谓词：把 async 函数传进去它会立刻返回 true）。 */
async function waitForAsync(predicate, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

test('周期任务：宿主定时器真的会把到点的任务推给插件，且不会重复推', async (t) => {
  // 把检查间隔压到 40ms 才好在测试里观察；manifest 的 everyMs 下限仍是 1 分钟，
  // 所以"第一次该触发、之后一分钟内不该再来一次"正好可以在这里钉住。
  const registry = new PluginRegistry({
    root: FIXTURES, dataDir, log: () => {},
    getConfig: () => ({ plugins: { enabled: true, enabledIds: ['good'], settings: {} } }),
    scheduleIntervalMs: 40
  });
  t.after(() => registry.stop());
  assert.deepEqual((await registry.start()).started, ['good']);
  const host = registry.hosts.get('good');
  assert.equal(await waitForAsync(async () => (await host.callTool('counters', {})).ticks >= 1, 3000), true,
    '到点后宿主该把 schedule 推下去（从没跑过＝立即算到点）');
  const after = await host.callTool('counters', {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  const later = await host.callTool('counters', {});
  assert.equal(later.ticks, after.ticks, '一分钟内不该重复触发（先记时间再执行，防重入）');
  assert.ok(registry.list().plugins.find((p) => p.id === 'good').manifest.schedule[0].lastRunAt > 0,
    '控制台要能看到"上次跑是什么时候"');
});

// 入站投递点接在 **落库之后、唤醒之前**（锚点：这段在 console 的事件处理里，单测拿不到 ——
// 与 settings 那批接线用例同一套做法：能锚的锚住，别让"接线掉了"全靠人眼）。
test('入站投递的接线：位置在唤醒之前、只投别人的消息、内容是最小集', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'src', 'console', 'app.js'), 'utf8');
  const observeAt = app.indexOf('pluginRegistry.observe({');
  assert.ok(observeAt > 0, '入站要把消息投给插件');
  const wakeAt = app.indexOf('orchestrator.onIncoming(chatKey)');
  assert.ok(wakeAt > 0 && observeAt < wakeAt, '投递要在唤醒之前（否则插件看到的消息已经进过模型了）');
  // 只投别人发的：自己发的不投（v1 插件发不了言，但 send 能力开了之后会形成自问自答的环）
  assert.match(app.slice(Math.max(0, observeAt - 200), observeAt), /if \(!isSelf\)/,
    '投递点要在 if (!isSelf) 里');
  // 内容是"已去重、已洗过"的最小集：内部字段（media/reply 等）不外发
  for (const field of ['mid: stored.mid', 'senderId: stored.senderId', 'text: stored.text']) {
    assert.ok(app.includes(field), `投递内容要包含 ${field}`);
  }
  assert.ok(!/pluginRegistry\.observe\(\{[^}]{0,400}media/.test(app), '不该把 media 等内部字段递给插件');
});

// 控制台那一侧：路由与页面接线的锚点（这些要通过真起服务器才测得到，与 settings 那批同一套做法）。
test('控制台接线：路由的守卫与设置页的分区都在（锚点）', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'src', 'console', 'app.js'), 'utf8');
  for (const route of ['/api/plugins', '/api/plugins/index', '/api/plugins/master',
    '/api/plugins/toggle', '/api/plugins/reload', '/api/plugins/install', '/api/plugins/uninstall']) {
    assert.ok(app.includes(`'${route}'`), `缺少路由 ${route}`);
  }
  // 卸载是破坏性操作：必须有 confirm 门槛（与全站口径一致）
  assert.match(app, /卸载插件需要 body\.confirm === true/);
  // enabledIds 是**数组**：deepMerge 对数组本来就是整体替换 —— 写成 { __replace__: [...] } 会被
  // 静默忽略（那个约定只认对象），于是"启用"永远写不进去（2026-10-15 复审 P1-1，实测复现过）
  assert.match(app, /updateConfig\(\{ plugins: \{ enabledIds: next \} \}\)/);
  assert.ok(!app.includes('enabledIds: { __replace__'), '授权清单不该再用 __replace__（数组是整体替换）');
  // 从索引装时以索引里的 tarball/sha256 为准（不信请求体里那份）
  assert.match(app, /url = hit\.tarball;/);
  assert.match(app, /sha256 = hit\.sha256;/);
  // 启停/装卸都要重排（否则"点了没反应"）
  assert.ok((app.match(/pluginRegistry\.reconfigure\(\)/g) || []).length >= 4, '各动作后都要重排');

  const settings = fs.readFileSync(path.join(process.cwd(), 'ui', 'pages', 'settings.js'), 'utf8');
  assert.ok(settings.includes("['plugins', '插件']"), '侧栏要有入口');
  assert.ok(settings.includes('plugins: () => renderPluginsSection(c)'), '分区路由要接上');
  const page = fs.readFileSync(path.join(process.cwd(), 'ui', 'pages', 'plugins.js'), 'utf8');
  assert.ok(page.includes('id="settings-plugins"'), '分区要有自己的锚点 id');
  assert.ok(page.includes('第三方代码'), '信任声明要出现在界面上（不能只写在文档里）');
  assert.ok(page.includes('拦不住网络'), '如实说明拦不住网络（Node 权限模型不管网络）');
  assert.ok(page.includes('if (delegationBound) return;'), '委托只能绑一次（#settings-form 长期存在，重绑会一次点击发两次请求）');
  const html = fs.readFileSync(path.join(process.cwd(), 'ui', 'index.html'), 'utf8');
  assert.ok(html.includes('/pages/plugins.js'), '新页面模块要在 index.html 里加载');
});

test('示例插件（examples/plugins/mc-status）真能跑：manifest 合法、工具能调、网络走宿主那道守卫', async (t) => {
  const dir = path.join(process.cwd(), 'examples', 'plugins', 'mc-status');
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  assert.equal(parsed.ok, true, `示例插件的 manifest 必须合法：${parsed.error}`);
  // 把状态接口指到内网地址：宿主侧的 safe-fetch 会拦下 —— 这同时证明了"插件不是自己发请求"，
  // 也避免了用例去碰真网络（本仓的测试纪律：不打真实网络）
  const host = new PluginHost({
    manifest: parsed.manifest,
    dataDir,
    log: () => {},
    getSettings: () => ({ statusUrl: 'http://127.0.0.1:9/{host}' })
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  await assert.rejects(
    () => host.callTool('players', { host: 'play.example.com' }),
    /内网|本机/,
    '内网地址必须被宿主侧的网络守卫拦下（插件拿不到裸 fetch 能力）'
  );
  const missing = await host.callTool('players', {});
  assert.match(String(missing?.error ?? ''), /服务器地址/, '参数缺失要给可读的错误（别把它当成模型的问题）');
});

test('P1-1 回归：授权清单能真的存下去（数组直接传，不走 __replace__）', async () => {
  const { updateConfig, getConfig } = await import('../src/core/config.js');
  updateConfig({ plugins: { enabledIds: ['demo'] } });
  assert.deepEqual(getConfig().plugins.enabledIds, ['demo'], '启用要能写进配置（此前 __replace__ 数组被静默忽略）');
  updateConfig({ plugins: { enabledIds: ['other'] } });
  assert.deepEqual(getConfig().plugins.enabledIds, ['other'], '数组是整体替换（停用要能删掉）');
  updateConfig({ plugins: { enabledIds: [] } });
});

test('P1-2 回归：宿主内部目录（.staging-/.backup-/.removed-）不算插件，也不该让巡检报红', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-internal-'));
  const root = path.join(dir, 'plugins');
  fs.mkdirSync(path.join(root, '.backup-demo-123'), { recursive: true });
  fs.writeFileSync(path.join(root, '.backup-demo-123', 'plugin.json'), JSON.stringify({
    id: 'demo', apiVersion: 1, name: '旧版', version: '0.9.0', capabilities: ['tools']
  }));
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo', 'plugin.json'), JSON.stringify({
    id: 'demo', apiVersion: 1, name: '演示', version: '1.0.0', capabilities: ['tools']
  }));
  const registry = new PluginRegistry({ root, dataDir: dir, log: () => {}, getConfig: () => ({ plugins: { enabled: true, enabledIds: [] } }) });
  assert.deepEqual(registry.discover().map((item) => item.id), ['demo'], '内部目录不该出现在插件清单里');
  assert.deepEqual(registry.list().plugins.map((item) => item.id), ['demo'], '控制台列表里也不该有幽灵行');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P2-2 回归：带路径穿越的 id 在写盘之前就被拒（staging 目录名不能带出插件目录）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-evil-id-'));
  const { buildTar } = await import('./helpers/tar.mjs');
  const { installPlugin } = await import('../src/plugins/install.js');
  const tar = buildTar([
    { name: 'plugin.json', data: JSON.stringify({ id: 'demo', apiVersion: 1, name: '演示', version: '1.0.0', capabilities: ['tools'] }) },
    { name: 'index.mjs', data: 'export const ok = 1;' }
  ]);
  for (const evil of [['..', '..', 'evil'].join('/'), 'demo/../evil', 'DEMO']) {
    await assert.rejects(
      () => installPlugin({ tarball: tar, id: evil, dataDir: dir }),
      // 认**错误码**而不是文案：E_BAD_ID 只在"写盘之前"那条分支上；用文案会让"校验被挪到解包之后"
      // 这种改动照样绿（后面那条 id 不一致的检查文案相同，但它已经发生在解包之后了）
      (error) => error?.code === 'E_BAD_ID',
      `id=${evil} 必须在建目录之前被拒`
    );
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'plugins')), [], '拒装之后插件目录里不该多出任何东西');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P2-3 回归：requireIsolation 是**真**开关（配置关掉时能起，且状态里如实标 unconfined）', async (t) => {
  if (permissionFlagSupported()) return;   // 有权限模型的机器上这条不成立（那种情况永远走隔离路径）
  const host = new PluginHost({
    manifest: fixtureManifest('good'), dataDir, log: () => {},
    requireIsolation: false,
    getSettings: () => ({})
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  assert.equal(host.unconfined, true, '降级运行时状态里必须标出来（控制台要显示给用户）');
});

test('P2-4 回归：隔离探测按**插件目录**分别做（缓存不许把一个目录的结论套给另一个）', async () => {
  const { probeIsolation, resetIsolationProbe, permissionFlagSupported } = await import('../src/plugins/isolation.js');
  if (!permissionFlagSupported()) return;   // 没有权限模型的机器上探测直接返回"不支持"，这条不成立
  resetIsolationProbe();
  const calls = [];
  // 注入一个"只对坏目录失败"的假 spawn：这样"缓存是否带目录键"就变成了可观测的行为差异
  const fakeSpawn = (_node, args) => {
    calls.push(args.join(' '));
    const bad = args.some((arg) => arg.includes('bad-dir'));
    return { status: bad ? 1 : 0, stderr: bad ? 'bad option' : '', error: null };
  };
  assert.equal(probeIsolation({ pluginDir: 'good-dir', spawn: fakeSpawn }).ok, true);
  assert.equal(calls.length, 1, '第一个目录要真的探一次');
  const second = probeIsolation({ pluginDir: 'bad-dir', spawn: fakeSpawn });
  assert.ok(calls.some((line) => line.includes('bad-dir')), '换了目录必须真的重新探（共用缓存会把好目录的结论套给坏目录）');
  assert.equal(second.ok, false, '坏目录要如实报不可用');
  assert.match(second.error, /bad option/, '要把子进程的原话带出来，不然排查只能靠猜');
  resetIsolationProbe();
});
