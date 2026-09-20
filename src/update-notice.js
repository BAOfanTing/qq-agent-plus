// 控制台「发现新版本」提示：只读检查 GitHub 目标分支是否有新提交，并取最新 Release 的说明。
// 本模块不做任何部署；点「立即更新」仍走既有的 /api/auto-update/run 链路。
// 站点数据只写入 auto-update.json 的 updateNotice / ignoredVersion 两个键，
// 与自动更新的既有字段互不影响。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readAutoUpdateState, writeAutoUpdateState } from './auto-update.js';

const CHECK_TTL_MS = 30 * 60 * 1000;
const RELEASE_TIMEOUT_MS = 15000;
const REVISION_LENGTH = 64;
const BODY_LIMIT = 8000;

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

/** 从仓库地址解析 GitHub owner/repo；非 github.com 返回 null。 */
export function parseGithubRepo(repository) {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)$/i.exec(String(repository || '').trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
}

/** 部署基线：deploy.sh 写入的 data/deployed-revision，缺失时退回状态文件里的记录。 */
export function deployedRevisionAt(dataDir, state = null) {
  try {
    const revision = cleanText(fs.readFileSync(path.join(dataDir, 'deployed-revision'), 'utf8'), REVISION_LENGTH);
    if (revision) return revision;
  } catch { /* 从未部署过 */ }
  return cleanText(state?.currentRevision, REVISION_LENGTH);
}

/**
 * 用 git ls-remote 取目标分支的远端 revision（不拉取对象）。
 * 沿用自动更新的网络设置：HTTP/1.1 与连通性超时。
 */
export function probeRemoteRevision(repository, branch, settings = {}, options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  const args = [];
  if (settings.forceHttp11 !== false) args.push('-c', 'http.version=HTTP/1.1');
  args.push('ls-remote', repository, `refs/heads/${branch}`);
  const timeout = Math.max(5000, (Number(settings.connectivityTimeoutSeconds) || 20) * 1000);
  return new Promise((resolve) => {
    const started = Date.now();
    execFileImpl('git', args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      const latencyMs = Date.now() - started;
      if (error) {
        resolve({ ok: false, latencyMs, error: cleanText(stderr || error.message, 300) || 'git ls-remote 失败' });
        return;
      }
      const line = String(stdout || '').trim().split('\n')[0] || '';
      const revision = cleanText(line.split(/\s+/)[0], REVISION_LENGTH);
      if (!revision) {
        resolve({ ok: false, latencyMs, error: '目标分支没有返回 revision' });
        return;
      }
      resolve({ ok: true, latencyMs, revision });
    });
  });
}

/** 取 GitHub 最新 Release（公开仓库无需令牌）；失败返回 null，不抛出。 */
export async function fetchLatestRelease(repository, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const slug = parseGithubRepo(repository);
  if (!slug) return null;
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases/latest`,
      {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'qq-agent-plus-console' },
        signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS)
      }
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return {
      version: cleanText(data.tag_name, 64),
      name: cleanText(data.name, 200),
      body: cleanText(data.body, BODY_LIMIT),
      publishedAt: Date.parse(data.published_at) || 0,
      url: cleanText(data.html_url, 500)
    };
  } catch {
    return null;
  }
}

/**
 * 检查是否有新版本。结果缓存 30 分钟；若部署基线在缓存之后发生变化
 * （例如刚更新完），缓存立即失效并重新检查。
 */
export async function checkForUpdate(dataDir, config = {}, { force = false, now = Date.now(), fetchImpl, execFileImpl } = {}) {
  const settings = config.autoUpdate || {};
  const repository = String(settings.repository || '').trim();
  const branch = String(settings.branch || 'main').trim() || 'main';
  const state = readAutoUpdateState(dataDir);
  const previous = state.updateNotice && typeof state.updateNotice === 'object' ? state.updateNotice : null;
  const deployedNow = deployedRevisionAt(dataDir, state);

  if (!repository) {
    return { available: false, reason: 'unconfigured', checkedAt: now, deployed: deployedNow };
  }
  const fresh = previous && previous.checkedAt && now - Number(previous.checkedAt) < CHECK_TTL_MS;
  const baselineUnchanged = previous && String(previous.deployed || '') === String(deployedNow || '');
  if (!force && fresh && baselineUnchanged) {
    return { ...previous, cached: true };
  }

  const probe = await probeRemoteRevision(repository, branch, settings, { execFileImpl });
  if (!probe.ok) {
    const notice = {
      available: false, reason: 'unreachable', repository, branch,
      revision: '', deployed: deployedNow,
      version: '', name: '', body: '', publishedAt: 0, url: '',
      checkedAt: now, error: probe.error || '连不上 GitHub'
    };
    writeAutoUpdateState(dataDir, { updateNotice: notice });
    return notice;
  }

  const available = Boolean(deployedNow) && probe.revision !== deployedNow;
  const release = available ? await fetchLatestRelease(repository, { fetchImpl }) : null;
  const notice = {
    available,
    reason: deployedNow ? '' : 'unknown-deployed',
    repository,
    branch,
    revision: cleanText(probe.revision, REVISION_LENGTH),
    deployed: deployedNow,
    version: release?.version || '',
    name: release?.name || '',
    body: release?.body || '',
    publishedAt: release?.publishedAt || 0,
    url: release?.url || '',
    checkedAt: now,
    error: ''
  };
  writeAutoUpdateState(dataDir, { updateNotice: notice });
  return notice;
}

/** 「忽略这个版本」：只屏蔽该 tag；出现更新版本时照常提示。 */
export function ignoreVersion(dataDir, version) {
  const clean = cleanText(version, 64);
  if (!clean) return '';
  writeAutoUpdateState(dataDir, { ignoredVersion: clean });
  return clean;
}
