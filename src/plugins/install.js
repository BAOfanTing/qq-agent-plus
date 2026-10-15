// 插件安装器：从官方索引或一个 URL 把插件装进 `$DATA_DIR/plugins/<id>/`。
//
// 装的是**别人写的代码**，所以这一层每一步都要能挡人：
//   · URL 只走 safe-fetch（内网/ SSRF / 体积 / 超时都在里面），不做裸 fetch；
//   · **必须给 sha256**（索引里带、或用户手填）：不给就拒绝装 —— "从网上抓一段代码跑起来"
//     这件事至少要让安装者对内容有个可核对的锚点；
//   · 解包自己解析 tar（不 shell 出去调 tar）：能逐条拒绝目录穿越、绝对路径、符号链接、
//     硬链接与设备节点 —— 交给外部 tar 就管不住这些；
//   · 先解到 staging 目录、校验 manifest（与宿主同一份校验）、再原子换入；换入前把旧版本挪到
//     备份目录，失败原样放回（"装坏了但旧版也没了"是最难受的失败模式）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parsePluginManifest } from './manifest.js';

export const MAX_PLUGIN_ARCHIVE_BYTES = 5 * 1024 * 1024;   // 插件是"几个 JS 文件"，5MB 足够
const MAX_TOTAL_UNPACKED = 20 * 1024 * 1024;

const fail = (code, message) => Object.assign(new Error(message), { code });

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** sha256 十六进制串的形状校验（大小写都收，比较时统一小写）。 */
export function isSha256(value) {
  return /^[0-9a-f]{64}$/i.test(String(value ?? '').trim());
}

export function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function verifySha256(buffer, expected) {
  const want = String(expected ?? '').trim().toLowerCase();
  if (!isSha256(want)) throw fail('E_SHA_SHAPE', 'sha256 必须是 64 位十六进制');
  const got = sha256Of(buffer);
  if (got !== want) throw fail('E_SHA_MISMATCH', `内容校验失败：期望 ${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…`);
  return true;
}

const TAR_BLOCK = 512;

/** tar 头校验和：把 checksum 字段当空格求和，与头里写的八进制值比对。 */
function verifyTarChecksum(header) {
  const declared = readOctal(header.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  if (declared !== sum) throw fail('E_ARCHIVE', '归档头校验和不匹配（文件损坏，或根本不是 tar）');
}

/** 解一段八进制字段（tar 里都是 "\0" 结尾的八进制串）。 */
function readOctal(buffer) {
  const text = buffer.toString('utf8').replace(/\0.*$/, '').trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 解析 tar（.tar 或 .tar.gz）成 `{ name, type, data }` 列表。
 * **逐条拒绝**：绝对路径、`..`（目录穿越）、符号链接/硬链接/设备节点（只有普通文件与目录放行）。
 * 不认识的结构直接报错 —— 宁可装不上，也不要"以为自己装的是 A、其实解出来一堆别的东西"。
 */
export function parseTarGz(buffer) {
  let raw = buffer;
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try { raw = zlib.gunzipSync(buffer); } catch (error) { throw fail('E_ARCHIVE', `不是合法的 gzip：${error?.message ?? error}`); }
  }
  const entries = [];
  let offset = 0;
  let total = 0;
  while (offset + TAR_BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + TAR_BLOCK);
    // 全零块 = 归档结束（正常有两个）
    if (header.every((byte) => byte === 0)) break;
    // 校验和：tar 头自带的完整性判据。不验的话，坏掉的归档会被"按字段解出另一份内容"，
    // 而 sha256 校的是整个包 —— 两者本该一致，坏就坏在解析层（2026-10-15 复审 P3-8）
    verifyTarChecksum(header);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = readOctal(header.subarray(124, 136));
    const typeByte = header[156];
    const type = String.fromCharCode(typeByte || 0x30);
    // 名字归一化：`tar -czf x .` 打出来的条目叫 `./x`，`tar -czf x dir/` 会带尾斜杠 ——
    // 不归一化的话后面按名字找 plugin.json 就会找不到（而且 `./` 这种根条目要当不存在）。
    const full = (prefix ? `${prefix}/${name}` : name)
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/$/, '');
    offset += TAR_BLOCK;
    const dataEnd = offset + size;
    if (dataEnd > raw.length) throw fail('E_ARCHIVE', '归档被截断（头的长度与实际内容不一致）');
    if (!full || full === '.') {
      // 归档根（`./`）没有内容要写，跳过；但数据块还是要按长度跳过去
      offset = dataEnd + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
      continue;
    }

    if (!['0', '\0', '5'].includes(type)) {
      // 'x'/'L' 是 pax 扩展头与 GNU 长路径头：真支持它们得先解析扩展属性，否则会解出错的路径。
      // v1 直接拒绝并给出可操作的指引，比"悄悄解错"强。
      const hint = (type === 'x' || type === 'L' || type === 'g')
        ? '（归档用了 pax/长路径扩展头：请用 `tar --format=ustar -czf` 重打，或把文件名缩短）'
        : '（符号链接/硬链接/设备节点都不允许）';
      throw fail('E_ARCHIVE', `归档里有不允许的条目类型 ${type}${hint}`);
    }
    if (!full || full.startsWith('/') || /^[A-Za-z]:/.test(full) || full.split('/').some((seg) => seg === '..')) {
      throw fail('E_ARCHIVE', `归档里有不安全的路径：${full || '(空)'}`);
    }
    total += size;
    if (total > MAX_TOTAL_UNPACKED) throw fail('E_ARCHIVE', '解包后体积超过上限，已拒绝安装');
    if (type !== '5') entries.push({ name: full, type: 'file', data: raw.subarray(offset, dataEnd) });
    else entries.push({ name: full.replace(/\/$/, ''), type: 'dir', data: null });
    offset = dataEnd + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
  }
  if (!entries.length) throw fail('E_ARCHIVE', '归档里没有任何文件');
  return entries;
}

/** 把条目写进目标目录（只在解析器已经校验过路径的前提下调用）。 */
export function extractEntries(entries, targetDir) {
  for (const entry of entries) {
    const full = path.join(targetDir, entry.name);
    if (full !== targetDir && !full.startsWith(targetDir + path.sep)) {
      throw fail('E_ARCHIVE', `拒绝写出目录外：${entry.name}`);
    }
    if (entry.type === 'dir') { fs.mkdirSync(full, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entry.data);
  }
}

/**
 * 常见的打包形状是"外层套一个目录"（`tar -czf x.tar.gz myplugin/`）：
 * 里面只有一层目录、且根下没有 plugin.json 时，把这一层剥掉再按根处理。
 */
function unwrapSingleRoot(entries) {
  if (entries.some((entry) => entry.name === 'plugin.json')) return entries;
  const tops = new Set(entries.map((entry) => entry.name.split('/')[0]));
  if (tops.size !== 1) return entries;
  const [top] = [...tops];
  if (!top || entries.some((entry) => entry.name === top && entry.type === 'file')) return entries;
  return entries
    .filter((entry) => entry.name !== top)
    .map((entry) => ({ ...entry, name: entry.name.slice(top.length + 1) }))
    .filter((entry) => entry.name);
}

/**
 * 从索引项或手填信息安装一个插件。
 * @param fetchBinary  注入点（默认 safe-fetch 的二进制下载，测试可注入）
 * @returns {ok, id, version, upgraded, backupDir?} 或抛带 code 的错误
 */
export async function installPlugin({
  id = '', url = '', sha256 = '', tarball = null, dataDir,
  fetchBinary, log = () => {}, now = () => Date.now()
} = {}) {
  // 注入点先落到本地常量：scan --strict（CI 门禁）不认"直接调用解构参数的默认值"这种形状
  const download = fetchBinary;
  const pluginsRoot = path.join(dataDir, 'plugins');
  fs.mkdirSync(pluginsRoot, { recursive: true });
  // id 会进 staging 的目录名：**必须先校验**，否则 '../../x' 之类的 id 会把解包写到插件目录之外
  //（2026-10-15 复审 P2；最终换入那一步本来就有校验，这里只是把它提前到"写盘之前"）
  const requestedId = String(id ?? '').trim();
  if (requestedId && !/^[a-z0-9][a-z0-9-]{1,31}$/.test(requestedId)) {
    // 独立错误码：与下面那条"包里的 id 与预期不符"区分开 —— 这一条发生在**任何写盘之前**，
    // 混用同一个 code/文案的话，用例咬不出"校验被挪到写盘之后"这种改动（2026-10-15 复审）
    throw fail('E_BAD_ID', '插件 id 不合法（只允许小写字母/数字/连字符，2-32 位）');
  }

  let buffer = tarball;
  if (!buffer) {
    const target = String(url ?? '').trim();
    if (!target) throw fail('E_ARGS', '缺少下载地址');
    if (!isSha256(sha256)) {
      throw fail('E_SHA_REQUIRED', '必须提供 sha256（安装第三方代码前，至少要有一个可核对的内容锚点）');
    }
    if (typeof fetchBinary !== 'function') throw fail('E_NO_FETCH', '没有可用的下载实现');
    const downloaded = await download(target, MAX_PLUGIN_ARCHIVE_BYTES);
    buffer = downloaded?.buffer;
    if (!buffer?.length) throw fail('E_DOWNLOAD', '下载内容为空');
    if (buffer.length > MAX_PLUGIN_ARCHIVE_BYTES) throw fail('E_DOWNLOAD', `超过体积上限 ${MAX_PLUGIN_ARCHIVE_BYTES / 1024 / 1024}MB`);
  }
  if (!buffer?.length) throw fail('E_ARGS', '没有可安装的内容');
  if (isSha256(sha256)) verifySha256(buffer, sha256);

  const entries = unwrapSingleRoot(parseTarGz(buffer));
  const staging = path.join(pluginsRoot, `.staging-${requestedId || 'plugin'}-${process.pid}-${now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    extractEntries(entries, staging);
    // manifest 必须合法、且 id 与目录名一致（与宿主同一份校验：两处口径分裂会出人命）
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(path.join(staging, 'plugin.json'), 'utf8')); }
    catch { throw fail('E_MANIFEST', '包里没有 plugin.json（或不是合法 JSON）'); }
    const parsed = parsePluginManifest(raw, { dir: staging });
    if (!parsed.ok) throw fail('E_MANIFEST', parsed.error);
    if (id && parsed.manifest.id !== id) throw fail('E_ID_MISMATCH', `包里的 id（${parsed.manifest.id}）与预期（${id}）不一致`);
    const finalId = parsed.manifest.id;
    const target = path.join(pluginsRoot, finalId);
    if (path.dirname(target) !== pluginsRoot) throw fail('E_ARGS', '插件 id 不合法');

    let backupDir = '';
    const upgrading = fs.existsSync(target);
    if (upgrading) {
      backupDir = path.join(pluginsRoot, `.backup-${finalId}-${now()}`);
      fs.renameSync(target, backupDir);   // 同一文件系统内 rename：换入是原子的
    }
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (upgrading && backupDir && !fs.existsSync(target)) fs.renameSync(backupDir, target);   // 失败原样放回
      throw fail('E_SWAP', `换入失败，已回滚：${error?.message ?? error}`);
    }
    pruneBackups(pluginsRoot, finalId, now);
    log(`[plugins] ${upgrading ? '升级' : '安装'} ${finalId} v${parsed.manifest.version} 完成`
      + `${upgrading ? `（旧版备份在 ${path.basename(backupDir)}）` : ''}`);
    return { ok: true, id: finalId, version: parsed.manifest.version, upgraded: upgrading, backupDir };
  } catch (error) {
    // staging 目录必须清掉：留一堆 .staging-* 下次巡检还以为是插件
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 清不掉就留在那儿，巡检会报出来 */ }
    throw error;
  }
}

/** 升级备份只保留最近 N 份（与 deploy.sh 的快照保留同口径）：不留的话每次升级都堆一份代码。 */
const MAX_BACKUPS = 3;
export function pruneBackups(pluginsRoot, id, now = () => Date.now()) {
  let names = [];
  try { names = fs.readdirSync(pluginsRoot); } catch { return 0; }
  const mine = names.filter((name) => name.startsWith(`.backup-${id}-`)).sort();
  let removed = 0;
  for (const name of mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS))) {
    try { fs.rmSync(path.join(pluginsRoot, name), { recursive: true, force: true }); removed += 1; }
    catch { /* 删不掉就留着：巡检与控制台都已经会跳过它 */ }
  }
  void now;
  return removed;
}

/**
 * 卸载：**只挪走代码目录**，插件的数据（plugin-data/<id>）保留 ——
 * 按本仓的既有约定（禁用/移除不该顺手删数据），重装后状态还在。
 */
export function uninstallPlugin({ id, dataDir, now = () => Date.now() } = {}) {
  const name = String(id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) throw fail('E_ARGS', '插件 id 不合法');
  const root = path.join(dataDir, 'plugins');
  const target = path.join(root, name);
  if (path.dirname(target) !== root) throw fail('E_ARGS', '插件 id 不合法');
  if (!fs.existsSync(target)) throw fail('E_NOT_FOUND', `没有装着 ${name}`);
  const removed = path.join(root, `.removed-${name}-${now()}`);
  fs.renameSync(target, removed);
  return { ok: true, id: name, removedDir: removed, dataKept: path.join(dataDir, 'plugin-data', name) };
}

/**
 * 拉官方索引（一份 JSON）。
 * 用 safe-fetch：索引地址是用户填的 URL，内网/SSRF/体积/超时都要挡住（与 web_fetch 同一套守卫）。
 */
export async function fetchPluginIndex({ url, fetchText, log = () => {} } = {}) {
  const grab = fetchText;   // 同上：别直接调用解构参数的默认值
  const target = String(url ?? '').trim();
  if (!target) throw fail('E_ARGS', '没有配置索引地址');
  if (typeof fetchText !== 'function') throw fail('E_NO_FETCH', '没有可用的抓取实现');
  const result = await grab(target);
  if (Number(result?.statusCode) !== 200) throw fail('E_INDEX', `索引拉取失败：HTTP ${result?.statusCode ?? '?'}`);
  let parsed = null;
  try { parsed = JSON.parse(String(result?.body ?? '')); } catch { throw fail('E_INDEX', '索引不是合法 JSON'); }
  const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : null;
  if (!plugins) throw fail('E_INDEX', '索引里没有 plugins 数组');
  const list = [];
  for (const item of plugins) {
    if (!isPlainObject(item)) continue;
    const id = String(item.id ?? '').trim();
    const tarball = String(item.tarball ?? '').trim();
    const sha = String(item.sha256 ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id) || !tarball || !isSha256(sha)) {
      log(`[plugins] 索引里这一项不完整，已跳过：${id || '(没有 id)'}`);
      continue;
    }
    list.push({
      id,
      name: String(item.name ?? id).slice(0, 100),
      version: String(item.version ?? '').slice(0, 40),
      description: String(item.description ?? '').slice(0, 300),
      capabilities: Array.isArray(item.capabilities) ? item.capabilities.filter((c) => typeof c === 'string') : [],
      tarball,
      sha256: sha
    });
  }
  return list;
}
