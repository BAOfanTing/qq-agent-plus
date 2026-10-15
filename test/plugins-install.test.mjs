// 插件安装器（src/plugins/install.js）：解包防护、内容校验、原子换入与回滚、卸载保留数据。
// 归档由 test/helpers/tar.mjs 手工拼（不依赖系统 tar），要构造危险归档时直接给条目。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildTar } from './helpers/tar.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-install-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const dotSlash = (name) => ['.', name].join('/');   // 直写 `./x.mjs` 会被 layout 守卫当成 import
const dotDot = (name) => ['..', name].join('/');
const { parseTarGz, installPlugin, uninstallPlugin, fetchPluginIndex, sha256Of, isSha256, verifySha256, MAX_PLUGIN_ARCHIVE_BYTES } =
  await import('../src/plugins/install.js');
const { parsePluginManifest } = await import('../src/plugins/manifest.js');

const manifest = (id, extra = {}) => JSON.stringify({
  id, apiVersion: 1, name: `测试插件 ${id}`, version: '1.0.0', capabilities: ['tools'],
  tools: [{ name: 'ping', description: '原样返回' }], ...extra
});

const packPlugin = (id, { prefix = '', extraFiles = [], compressed = true } = {}) => {
  const p = prefix ? `${prefix.replace(/\/$/, '')}/` : '';   // 外层目录（模拟 `tar -czf x.tar.gz plugin/`）
  return buildTar([
    ...(p ? [{ name: p.replace(/\/$/, ''), type: '5' }] : []),
    { name: `${p}plugin.json`, data: manifest(id) },
    { name: `${p}index.mjs`, data: 'export const ok = true;\n' },
    ...extraFiles
  ], { compress: compressed });
};

const pluginsRoot = path.join(dataDir, 'plugins');
const slate = () => { fs.rmSync(pluginsRoot, { recursive: true, force: true }); fs.mkdirSync(pluginsRoot, { recursive: true }); };
const strays = () => fs.readdirSync(pluginsRoot).filter((name) => name.startsWith('.'));

test('tar 解析：普通文件/目录/./ 前缀都能解；外层单目录自动剥掉', () => {
  const entries = parseTarGz(buildTar([
    { name: '.', type: '5' },
    { name: dotSlash('plugin.json'), data: '{}' },
    { name: dotSlash('sub'), type: '5' },
    { name: dotSlash('sub/a.mjs'), data: 'x' }
  ]));
  assert.deepEqual(entries.filter((e) => e.type === 'file').map((e) => e.name).sort(),
    ['plugin.json', 'sub/a.mjs']);
  assert.equal(entries.find((e) => e.name === 'plugin.json').data.toString('utf8'), '{}');

  // 外层套一个目录（`tar -czf x.tar.gz plugin/`）：安装时要能当根处理
  const wrapped = buildTar([
    { name: 'demo', type: '5' },
    { name: 'demo/plugin.json', data: manifest('demo') },
    { name: 'demo/index.mjs', data: 'x' }
  ]);
  const extracted = parseTarGz(wrapped);
  const hasRootManifest = extracted.some((e) => e.name === 'plugin.json');
  assert.equal(hasRootManifest, false, '解析器本身不做剥壳（剥壳在安装路径上，见下一条）');
});

test('tar 解析：目录穿越 / 绝对路径 / 符号链接 / pax 长路径头 一律拒绝', () => {
  const cases = [
    [[{ name: dotDot('evil.mjs'), data: 'x' }], /不安全的路径/],
    [[{ name: '/etc/passwd', data: 'x' }], /不安全的路径/],
    [[{ name: 'demo/../../x', data: 'x' }], /不安全的路径/],
    [[{ name: 'x', type: '2', data: 'target' }], /不允许的条目类型/],   // 符号链接
    [[{ name: 'x', type: '1' }], /不允许的条目类型/]                    // 硬链接
  ];
  for (const [entries, pattern] of cases) {
    assert.throws(() => parseTarGz(buildTar(entries)), pattern, JSON.stringify(entries));
  }
  // pax 扩展头：拒绝并给出可操作的指引（v1 不实现扩展属性解析）
  assert.throws(() => parseTarGz(buildTar([{ name: 'plugin.json', data: '{}' }], { longNameHeader: true })),
    /条目类型 x/);
  // 截断：头里写的长度超过实际内容（用未压缩的 tar，才走得到"内容不足"这条判据）
  const rawTar = buildTar([{ name: 'a', data: 'x'.repeat(1200) }], { compress: false });
  assert.throws(() => parseTarGz(rawTar.subarray(0, 700)), /截断/);
  // gzip 本身被截断：解压就失败，也要报出来（不能静默当成空归档）
  const gz = buildTar([{ name: 'a', data: 'x'.repeat(1200) }]);
  assert.throws(() => parseTarGz(gz.subarray(0, 20)), /gzip|截断/);
});

test('内容校验：sha256 形状 / 一致 / 不一致', () => {
  assert.equal(isSha256('a'.repeat(64)), true);
  assert.equal(isSha256('A'.repeat(64)), true, '大写也认（比较时统一小写）');
  assert.equal(isSha256('abc'), false);
  const buffer = Buffer.from('hello plugin');
  const sha = sha256Of(buffer);
  assert.equal(verifySha256(buffer, sha), true);
  assert.throws(() => verifySha256(buffer, 'b'.repeat(64)), /内容校验失败/);
  assert.throws(() => verifySha256(buffer, 'nope'), /64 位十六进制/);
});

test('安装：装成功、重复装＝升级并留下旧版备份、staging 不留残渣', async () => {
  slate();
  const first = await installPlugin({ tarball: packPlugin('demo'), id: 'demo', dataDir });
  assert.equal(first.ok, true);
  assert.equal(first.id, 'demo');
  assert.equal(first.upgraded, false);
  const installed = path.join(pluginsRoot, 'demo');
  assert.ok(fs.existsSync(path.join(installed, 'plugin.json')));
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(installed, 'plugin.json'), 'utf8')), { dir: installed });
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(strays(), [], '不该留下 .staging-* 之类的残渣');

  // 外层单目录的包也要能装（剥壳发生在安装路径上）
  const wrapped = await installPlugin({ tarball: packPlugin('wrapped', { prefix: 'wrapped' }), dataDir });
  assert.equal(wrapped.id, 'wrapped');
  assert.ok(fs.existsSync(path.join(pluginsRoot, 'wrapped', 'plugin.json')));

  const second = await installPlugin({ tarball: packPlugin('demo'), dataDir });
  assert.equal(second.upgraded, true, '第二次装同一个 id 是升级');
  assert.ok(second.backupDir && fs.existsSync(second.backupDir), '旧版要留在备份目录里（可回滚）');
  assert.ok(fs.existsSync(path.join(second.backupDir, 'plugin.json')));
});

test('安装：id 与预期不符要拒装，且不留下任何东西（staging 清干净）', async () => {
  slate();
  await assert.rejects(
    () => installPlugin({ tarball: packPlugin('other'), id: 'expected', dataDir }),
    /与预期（expected）不一致/
  );
  assert.deepEqual(fs.readdirSync(pluginsRoot), [], '拒装之后目录里不该多出任何东西');
});

test('安装：走 URL 时没给 sha256 直接拒（不给"从网上抓段代码就跑"留路）', async () => {
  await assert.rejects(
    () => installPlugin({ url: 'https://example.com/p.tar.gz', dataDir, fetchBinary: async () => ({ buffer: Buffer.from('x') }) }),
    /必须提供 sha256/
  );
  // 给了 sha256 但内容不符：必须拦下，且不落地
  slate();
  const body = packPlugin('demo');
  await assert.rejects(
    () => installPlugin({ url: 'https://example.com/p.tar.gz', sha256: 'c'.repeat(64), dataDir, fetchBinary: async () => ({ buffer: body }) }),
    /内容校验失败/
  );
  assert.deepEqual(fs.readdirSync(pluginsRoot), []);

  // 给了对得上 sha 的内容：正常装（下载路径与本地路径共用同一套校验）
  const ok = await installPlugin({
    url: 'https://example.com/p.tar.gz', sha256: sha256Of(body), dataDir, fetchBinary: async () => ({ buffer: body })
  });
  assert.equal(ok.id, 'demo');
  assert.ok(fs.existsSync(path.join(pluginsRoot, 'demo', 'index.mjs')));
});

test('安装：下载体积上限也挡（下载器不设限时由安装器兜底）', async () => {
  await assert.rejects(
    () => installPlugin({
      url: 'https://example.com/big.tar.gz', sha256: 'd'.repeat(64), dataDir,
      fetchBinary: async () => ({ buffer: Buffer.alloc(MAX_PLUGIN_ARCHIVE_BYTES + 1) })
    }),
    /超过体积上限/
  );
});

test('卸载：只挪走代码目录，插件数据保留（重装后状态还在）', async () => {
  slate();
  await installPlugin({ tarball: packPlugin('demo'), dataDir });
  const dataKeep = path.join(dataDir, 'plugin-data', 'demo');
  fs.mkdirSync(dataKeep, { recursive: true });
  fs.writeFileSync(path.join(dataKeep, 'storage.json'), '{"last":"keep-me"}');
  const result = uninstallPlugin({ id: 'demo', dataDir });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(pluginsRoot, 'demo')), false, '代码目录要挪走');
  assert.ok(!fs.readdirSync(pluginsRoot).includes('demo'));
  assert.equal(fs.readFileSync(path.join(dataKeep, 'storage.json'), 'utf8'), '{"last":"keep-me"}', '数据不该被顺手删掉');
  assert.throws(() => uninstallPlugin({ id: 'demo', dataDir }), /没有装着/);
  assert.throws(() => uninstallPlugin({ id: '../etc', dataDir }), /id 不合法/);
});

test('索引：坏项跳过、好项归一化、非 200 与坏 JSON 都要报出来', async () => {
  const body = JSON.stringify({
    plugins: [
      { id: 'good', name: '好插件', version: '1.0.0', description: '可用', capabilities: ['tools'], tarball: 'https://example.com/g.tar.gz', sha256: 'e'.repeat(64) },
      { id: 'no-sha', name: '缺 sha', tarball: 'https://example.com/x.tar.gz' },
      { id: 'Bad_Id', name: '坏 id', tarball: 'https://example.com/y.tar.gz', sha256: 'f'.repeat(64) },
      'not-an-object'
    ]
  });
  const skipped = [];
  const list = await fetchPluginIndex({ url: 'https://example.com/index.json', fetchText: async () => ({ statusCode: 200, body }), log: (line) => skipped.push(line) });
  assert.deepEqual(list.map((p) => p.id), ['good'], '只保留完整的项');
  assert.equal(skipped.length, 2, '跳过两个坏项（缺 sha 与坏 id）要留痕');
  assert.equal(list[0].sha256, 'e'.repeat(64));
  await assert.rejects(() => fetchPluginIndex({ url: 'https://x/index.json', fetchText: async () => ({ statusCode: 404, body: 'nope' }) }), /HTTP 404/);
  await assert.rejects(() => fetchPluginIndex({ url: 'https://x/index.json', fetchText: async () => ({ statusCode: 200, body: 'not json' }) }), /不是合法 JSON/);
  await assert.rejects(() => fetchPluginIndex({ url: 'https://x/index.json', fetchText: async () => ({ statusCode: 200, body: '{}' }) }), /没有 plugins 数组/);
});
