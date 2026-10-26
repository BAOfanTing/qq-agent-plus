// 技能市场：索引只提供元数据与文件哈希，安装时逐文件下载并校验。
// 技能不执行代码，所以这里不需要插件那套授权体系；但仍然限制体积、路径和来源，
// 装错的技能最多是"流程写得不对"，不能变成读写宿主文件。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../core/config.js';
import { safeFetchRequest } from '../llm/safe-fetch.js';
import { createIndexTextFetcher } from '../plugins/index-fetch.js';
import { getSkillRegistry, skillUserDir, validateSkillDir } from './registry.js';

const MAX_INDEX_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_FILES = 8;
const CACHE_TTL_MS = 30 * 60 * 1000;
const STALE_FALLBACK_MS = 7 * 86400000;
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const FILE_KEY_RE = /^[A-Za-z0-9_.-]{1,80}$/;

const clean = (value, max = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

let memoryCache = { url: '', at: 0, payload: null };

function cacheFile() {
  return path.join(skillUserDir(), '.market-cache.json');
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function packageHash(files) {
  return hash(Object.keys(files).sort().map((name) => `${name}:${files[name].sha256}`).join('\n'));
}

function compareVersions(left, right) {
  const parse = (value) => {
    const text = String(value || '').trim().replace(/^[vV]/, '').split('+')[0];
    const dash = text.indexOf('-');
    const core = (dash >= 0 ? text.slice(0, dash) : text).split('.').map((n) => Number(n) || 0);
    return { core, pre: dash >= 0 ? text.slice(dash + 1) : '' };
  };
  const a = parse(left); const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    if ((a.core[i] || 0) !== (b.core[i] || 0)) return (a.core[i] || 0) > (b.core[i] || 0) ? 1 : -1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre);
}

function textFetcher(maxBytes) {
  const allowPrivate = getConfig().skills?.allowPrivateIndex === true;
  return createIndexTextFetcher({
    fetchImpl: (url, options = {}) => safeFetchRequest(url, {
      maxBytes: options.maxBytes ?? maxBytes,
      signal: options.signal,
      headers: options.headers,
      allowPrivate
    }),
    maxBytes
  });
}

function resolveFileUrl(indexUrl, value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('文件缺少地址');
  const url = new URL(raw, indexUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('文件地址只允许 http/https');
  return url.toString();
}

function normalizeIndex(raw, indexUrl) {
  if (!isPlainObject(raw)) throw new Error('技能索引必须是 JSON 对象');
  const list = Array.isArray(raw.skills) ? raw.skills : [];
  if (!list.length) throw new Error('技能索引里没有技能');
  const skills = [];
  const seen = new Set();
  for (const item of list.slice(0, 200)) {
    if (!isPlainObject(item)) continue;
    const id = clean(item.id, 80);
    if (!SKILL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const files = {};
    if (isPlainObject(item.files)) {
      for (const [name, meta] of Object.entries(item.files).slice(0, MAX_FILES)) {
        if (!FILE_KEY_RE.test(name) || name.startsWith('.') || !/\.(json|md)$/i.test(name)) continue;
        if (!isPlainObject(meta)) continue;
        const sha256 = String(meta.sha256 || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(sha256)) continue;
        const bytes = Number(meta.bytes);
        if (Number.isFinite(bytes) && (bytes <= 0 || bytes > MAX_FILE_BYTES)) continue;
        try {
          files[name] = { url: resolveFileUrl(indexUrl, meta.url || meta.path), sha256, bytes: Number.isFinite(bytes) ? bytes : 0 };
        } catch { /* 单个坏文件跳过，安装时缺文件会失败 */ }
      }
    }
    if (!files['skill.json']) continue;
    const allowedTools = Array.isArray(item.allowedTools) ? item.allowedTools.map((t) => clean(t, 64)).filter(Boolean).slice(0, 40) : [];
    const triggers = Array.isArray(item.triggers) ? item.triggers.map((t) => clean(t, 40)).filter(Boolean).slice(0, 30) : [];
    skills.push({
      id,
      name: clean(item.name, 60) || id,
      description: clean(item.description, 200),
      version: clean(item.version, 32) || '1.0.0',
      author: clean(item.author, 80),
      category: clean(item.category, 40) || '其他',
      homepage: clean(item.homepage, 300),
      allowedTools,
      triggers,
      files,
      sha256: packageHash(files)
    });
  }
  if (!skills.length) throw new Error('技能索引里没有可用条目');
  return {
    version: Number(raw.version) || 1,
    name: clean(raw.name, 80) || '技能索引',
    updatedAt: clean(raw.updatedAt, 40),
    skills
  };
}

function readFileCache(url) {
  try {
    const text = fs.readFileSync(cacheFile(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed?.url !== url || !isPlainObject(parsed.payload)) return null;
    return { at: Number(parsed.at) || 0, index: normalizeIndex(parsed.payload, url) };
  } catch { return null; }
}

function writeFileCache(url, index, at) {
  try {
    const dir = skillUserDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = cacheFile();
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ url, at, payload: { version: index.version, name: index.name, updatedAt: index.updatedAt, skills: index.skills } }), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch { /* 缓存写失败不影响本次结果 */ }
}

export function resetMarketCacheForTests() {
  memoryCache = { url: '', at: 0, payload: null };
  try { fs.rmSync(cacheFile(), { force: true }); } catch { /* 忽略 */ }
}

export function marketIndexUrl() {
  return String(getConfig().skills?.indexUrl || '').trim();
}

export async function loadMarketIndex({ force = false } = {}) {
  const url = marketIndexUrl();
  if (!url) throw new Error('未配置技能索引地址（设置 → 技能 → 索引地址）');
  const now = Date.now();
  if (!force && memoryCache.url === url && memoryCache.payload && now - memoryCache.at < CACHE_TTL_MS) {
    return { index: memoryCache.payload, fetchedAt: memoryCache.at, stale: false, url };
  }
  const fileCache = readFileCache(url);
  if (!force && fileCache && now - fileCache.at < CACHE_TTL_MS) {
    memoryCache = { url, at: fileCache.at, payload: fileCache.index };
    return { index: fileCache.index, fetchedAt: fileCache.at, stale: false, url };
  }
  try {
    const response = await textFetcher(MAX_INDEX_BYTES)(url);
    if (response.statusCode !== 200) throw new Error(`索引 HTTP ${response.statusCode}`);
    if (response.truncated) throw new Error('索引超过 256KB 上限');
    const raw = JSON.parse(response.body);
    const index = normalizeIndex(raw, response.url || url);
    memoryCache = { url, at: now, payload: index };
    writeFileCache(url, index, now);
    return { index, fetchedAt: now, stale: false, url };
  } catch (error) {
    if (fileCache && now - fileCache.at < STALE_FALLBACK_MS) {
      memoryCache = { url, at: fileCache.at, payload: fileCache.index };
      return { index: fileCache.index, fetchedAt: fileCache.at, stale: true, url, error: String(error?.message || error) };
    }
    if (memoryCache.url === url && memoryCache.payload) {
      return { index: memoryCache.payload, fetchedAt: memoryCache.at, stale: true, url, error: String(error?.message || error) };
    }
    throw new Error(`读取技能索引失败：${error?.message || error}`);
  }
}

export async function listMarketSkills({ force = false } = {}) {
  const { index, fetchedAt, stale, url, error } = await loadMarketIndex({ force });
  const registry = getSkillRegistry();
  const installed = new Map(registry.list().map((skill) => [skill.id, skill]));
  return {
    ok: true,
    index: { name: index.name, updatedAt: index.updatedAt, url, fetchedAt, stale, error: error || '' },
    skills: index.skills.map((entry) => {
      const current = installed.get(entry.id);
      return {
        ...entry,
        installed: Boolean(current),
        installedVersion: current?.version || '',
        installedSource: current?.source || '',
        builtin: current?.source === 'builtin',
        updateAvailable: Boolean(current && compareVersions(entry.version, current.version) > 0)
      };
    })
  };
}

function findEntry(index, id) {
  const key = String(id || '').trim();
  const entry = index.skills.find((item) => item.id === key);
  if (!entry) throw new Error('索引里没有这个技能');
  return entry;
}

async function downloadFile(file, fetcher) {
  const result = await fetcher(file.url);
  if (result.statusCode !== 200) throw new Error(`技能文件 HTTP ${result.statusCode}`);
  if (result.truncated) throw new Error('技能文件超过 128KB 上限');
  const text = String(result.body || '');
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  if (digest !== file.sha256) throw new Error('文件哈希不匹配，已拒绝安装');
  if (!text.trim()) throw new Error('技能文件为空');
  if (text.includes('\0')) throw new Error('技能文件含 NUL 字符');
  return text;
}

async function downloadPackage(entry, fetcher) {
  const names = Object.keys(entry.files);
  let total = 0;
  const files = {};
  for (const name of names) {
    const text = await downloadFile(entry.files[name], fetcher);
    total += Buffer.byteLength(text, 'utf8');
    if (total > MAX_TOTAL_BYTES) throw new Error('技能包总大小超过 512KB 上限');
    files[name] = text;
  }
  return files;
}

function writePackage(dir, files) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 });
  }
}

function removeQuietly(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 忽略 */ }
}

export async function previewMarketSkill(id) {
  const { index, url, fetchedAt, stale } = await loadMarketIndex();
  const entry = findEntry(index, id);
  const files = await downloadPackage(entry, textFetcher(MAX_FILE_BYTES));
  const manifest = JSON.parse(files['skill.json']);
  const instructionsName = String(manifest.instructions || 'SKILL.md').trim();
  return {
    ok: true,
    url,
    fetchedAt,
    stale,
    entry: { ...entry, files: Object.fromEntries(Object.entries(entry.files).map(([name, meta]) => [name, { sha256: meta.sha256, bytes: meta.bytes }])) },
    instructions: String(files[instructionsName] || '').slice(0, 12000),
    manifest: {
      id: manifest.id, name: manifest.name, version: manifest.version,
      description: manifest.description, allowedTools: manifest.allowedTools || [], triggers: manifest.triggers || []
    }
  };
}

export async function installMarketSkill({ id, expectedSha256 = '', confirm = false } = {}) {
  if (confirm !== true) throw new Error('安装技能需要确认');
  const { index, url } = await loadMarketIndex();
  const entry = findEntry(index, id);
  if (expectedSha256 && String(expectedSha256) !== entry.sha256) {
    throw new Error('索引内容已变化，请刷新市场后重新确认');
  }
  const registry = getSkillRegistry();
  const current = registry.get(entry.id);
  if (current?.source === 'builtin') throw new Error('这是内置技能，不能从市场覆盖');
  const files = await downloadPackage(entry, textFetcher(MAX_FILE_BYTES));
  const userDir = skillUserDir();
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
  const temp = path.join(userDir, `.tmp-${entry.id}-${process.pid}-${Date.now()}`);
  const target = path.join(userDir, entry.id);
  const backup = path.join(userDir, `.backup-${entry.id}-${Date.now()}`);
  writePackage(temp, files);
  try {
    const validated = validateSkillDir(temp);
    if (validated.id !== entry.id) throw new Error('manifest 的 id 与索引不一致');
  } catch (error) {
    removeQuietly(temp);
    throw new Error(`技能包校验失败：${error?.message || error}`);
  }
  let movedOld = false;
  try {
    if (fs.existsSync(target)) { fs.renameSync(target, backup); movedOld = true; }
    fs.renameSync(temp, target);
    registry.reload();
    const installed = registry.get(entry.id);
    if (!installed || installed.source !== 'user') throw new Error('安装后未能加载，已回滚');
    removeQuietly(backup);
    return { ok: true, updated: Boolean(current), skill: registry.list().find((skill) => skill.id === entry.id), sourceUrl: url };
  } catch (error) {
    removeQuietly(target);
    if (movedOld) { try { fs.renameSync(backup, target); } catch { /* 忽略 */ } }
    registry.reload();
    throw error;
  } finally {
    removeQuietly(temp);
  }
}

export async function uninstallMarketSkill({ id, confirm = false } = {}) {
  if (confirm !== true) throw new Error('卸载技能需要确认');
  const registry = getSkillRegistry();
  const skill = registry.get(String(id || '').trim());
  if (!skill) throw new Error('技能不存在');
  if (skill.source !== 'user') throw new Error('内置技能不能卸载；可以停用');
  const userDir = path.resolve(skillUserDir());
  const target = path.resolve(userDir, skill.id);
  if (path.dirname(target) !== userDir) throw new Error('技能路径非法');
  const removed = path.join(userDir, `.removed-${skill.id}-${Date.now()}`);
  if (fs.existsSync(target)) fs.renameSync(target, removed);
  registry.reload();
  if (registry.get(skill.id)) {
    if (fs.existsSync(removed)) { try { fs.renameSync(removed, target); } catch { /* 忽略 */ } }
    throw new Error('卸载后技能仍在加载，已回滚');
  }
  removeQuietly(removed);
  return { ok: true, id: skill.id };
}
