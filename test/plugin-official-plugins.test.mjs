// 官方插件（examples/plugins/ 下全部）的验收用例。
//
// 这组用例回答三件事：
//   ① 每个 manifest 能不能过宿主那套 fail-closed 校验，联网的有没有声明 http 能力；
//   ② 插件有没有"自己发请求"——必须经宿主的 cap.http.request 那条路（才有内网拦截/体积上限/审计）；
//   ③ 参数校验是不是**在发请求之前**（坏参数本地就该报掉，不该拿它去打上游）。
//
// ⚠️ 后两条**真起子进程**（用与生产同一套 PluginHost），不 mock：隔离/守卫/协议只有真起进程
// 才测得到。为了让用例**不打真实网络**，网络相关的断言一律靠"把数据源指到内网地址、让宿主
// 侧的网络守卫拦下"来证明 —— 既验了守卫真的在，又不碰外网（见 docs/PLUGINS.md 的宿主侧纪律）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 与 test/plugins.test.mjs 同一套做法：数据目录指到临时目录，退出时清掉
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-official-plugins-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { parsePluginManifest, SUPPORTED_API_VERSIONS } = await import('../src/plugins/manifest.js');
const { PluginHost } = await import('../src/plugins/host.js');

// 通用护栏（manifest 合法 / 不自己发请求 / 请求都走 cap.http.request）对**全部官方插件**跑，
// 清单直接来自 plugins/official-packages.json —— 那是"哪些插件算官方"的唯一来源，也是
// "改了源码忘了重打包"的锚。好处：新加一个 examples/plugins/<id> 就必须补一条锚（否则
// test/plugin-index.test.mjs 会红），补了锚就自动被这三条护栏覆盖，不会漏。
const ANCHORS = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'plugins', 'official-packages.json'), 'utf8'));
const IDS = Object.keys(ANCHORS.packages || {}).sort();
// 这五个是本轮新增的（有自己的坏参数/守卫用例）；它们在 IDS 里也要在，两边不许漂移
const NEW_IDS = ['translate', 'hot-topics', 'exchange-rate', 'ip-info', 'rss'];
const dirOf = (id) => path.join(process.cwd(), 'examples', 'plugins', id);

/** 读 manifest 并断言它合法（dir 用绝对路径 —— 校验要拿它验 entry 不越界）。 */
function manifestOf(id) {
  const dir = dirOf(id);
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  assert.equal(parsed.ok, true, `${id} 的 manifest 必须合法：${parsed.error}`);
  return parsed.manifest;
}

/** 起一个真宿主；用完由调用方 stop（或交给 t.after）。 */
async function startHost(id, settings = {}) {
  const host = new PluginHost({ manifest: manifestOf(id), dataDir, log: () => {}, getSettings: () => settings });
  assert.equal(await host.start(), true, `${id} 起不来：${host.lastError}`);
  return host;
}

test('官方插件：manifest 合法，id 与目录名一致，联网的都声明了 http 能力', () => {
  // 2026-10-16 下架 mc-status（与内置能力重复度低但实用性也低：只有跑 MC 服的人用得上）
  assert.ok(IDS.length >= 7, `官方插件至少 7 个（实际 ${IDS.length}）`);
  for (const id of NEW_IDS) assert.ok(IDS.includes(id), `${id} 必须在这份清单里（两处清单不许漂移）`);
  for (const id of IDS) {
    const manifest = manifestOf(id);
    assert.equal(manifest.id, id, 'id 必须与目录名一致');
    assert.ok(SUPPORTED_API_VERSIONS.includes(manifest.apiVersion), `apiVersion 必须是宿主支持的 ${SUPPORTED_API_VERSIONS.join('/')}`);
    assert.ok(manifest.tools.length >= 1, `${id} 至少要声明一个工具（否则装上也没用）`);
    // 这五个都要联网；漏声明 http 的运行期表现是"越权被拒"，装的时候就要发现
    assert.ok(manifest.capabilities.includes('http'), `${id} 要联网就必须声明 http 能力`);
    assert.ok(manifest.capabilities.includes('tools'), `${id} 声明了工具就得带上 tools 能力`);
  }
});

test('官方插件：不自己发请求（没有裸 fetch、没直接开 http(s)，且请求都走 cap.http.request）', () => {
  for (const id of IDS) {
    const src = fs.readFileSync(path.join(dirOf(id), 'index.mjs'), 'utf8');
    // 这条是"插件不许自己发请求"的护栏：走宿主那条路才有内网拦截/体积上限/超时/审计
    assert.ok(!/\bfetch\s*\(/.test(src), `${id} 不许自己 fetch（要联网只能经宿主的 cap.http.request）`);
    assert.ok(
      !/require\(['"]https?['"]\)|from\s+['"]node:https?['"]|require\(['"]node:https?['"]/.test(src),
      `${id} 不许直接 require/import http(s) 模块`
    );
    assert.ok(src.includes('cap.http.request'), `${id} 的请求必须走 cap.http.request`);
  }
});

test('hot-topics 真起子进程：把数据源指到内网，宿主侧的网络守卫必须拦下（用例不打真网络）', async (t) => {
  // 把 V2EX 热帖地址指到本机 —— 宿主侧的 safe-fetch 会拦下它。这同时证明了两件事：
  //   · 守卫真的在（插件拿不到"自己发请求"的能力就跑不到上游）；
  //   · 插件确实是经宿主出的网（它自己发的话根本不会经过这道守卫，也就不会有这个报错）。
  const host = await startHost('hot-topics', { v2exUrl: 'http://127.0.0.1:9/hot.json' });
  t.after(() => host.stop());
  await assert.rejects(
    () => host.callTool('list', { source: 'v2ex' }),
    /内网|本机/,
    '内网地址必须被宿主侧的网络守卫拦下'
  );
});

test('官方插件（本轮新增的五个）：坏参数在**发请求之前**就被拦下（不拿坏参数去打上游）', async (t) => {
  // 网络错误的字样：坏参数这条路上**不该**出现这些。出现了就说明它真的去打了上游
  //（用例会因此变红，同时也会去碰外网 —— 这在本仓的测试纪律里是不允许的）。
  const NETWORK_NOISE = /内网|本机|HTTP \d|超时|timed out|timeout|ENETUNREACH|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|网络/i;

  // 每个插件的"坏参数"：缺必填、或必填给了空串。hot-topics 没有必填参数，就用"传了但为空"的来源。
  const cases = [
    { id: 'translate', tool: 'text', args: {} },
    { id: 'translate', tool: 'text', args: { text: '   ' } },          // 空白字符串等于没给
    { id: 'hot-topics', tool: 'list', args: { source: '' } },
    { id: 'exchange-rate', tool: 'convert', args: {} },
    { id: 'exchange-rate', tool: 'convert', args: { amount: '', from: '', to: '' } },
    { id: 'ip-info', tool: 'lookup', args: {} },
    { id: 'ip-info', tool: 'lookup', args: { query: '' } },
    { id: 'rss', tool: 'latest', args: {} },
    { id: 'rss', tool: 'latest', args: { url: '' } }
  ];

  const hosts = new Map();
  t.after(async () => { for (const host of hosts.values()) await host.stop(); });
  for (const item of cases) {
    let host = hosts.get(item.id);
    if (!host) {
      host = await startHost(item.id);
      hosts.set(item.id, host);
    }
    const result = await host.callTool(item.tool, item.args);
    const message = String(result?.error ?? '');
    // 插件用"结果里的 error 字段"如实报错（不是抛异常）：模型与用户都靠它判断
    assert.ok(message.length > 0,
      `${item.id}.${item.tool}(${JSON.stringify(item.args)}) 坏参数要给非空 error，实际 ${JSON.stringify(result)}`);
    assert.ok(!NETWORK_NOISE.test(message),
      `${item.id}.${item.tool} 的坏参数报错里不该有网络字样（说明它没去打上游）：${message}`);
  }
});
