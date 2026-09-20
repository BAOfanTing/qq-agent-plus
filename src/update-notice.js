// 控制台「发现新版本」提示：只读检查 GitHub 目标分支是否有新提交，并取最新 Release 的说明。
// 本模块不做任何部署；点「立即更新」仍走既有的 /api/auto-update/run 链路。
// 站点数据只写入 auto-update.json 的 updateNotice / ignoredVersion 两个键，
// 与自动更新的既有字段互不影响。
//
// 取远端 revision 优先走 GitHub API（api.github.com 通常可达），
// git ls-remote 只作兜底：实测服务器到 github.com 的 git 传输会整条卡死，
// 而 api.github.com 正常。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readAutoUpdateState, writeAutoUpdateState } from './auto-update.js';

const CHECK_TTL_MS = 30 * 60 * 1000;
const API_TIMEOUT_MS = 10000;
const REVISION_LENGTH = 64;
const BODY_LIMIT = 8000;
const COMMIT_FALLBACK_COUNT = 10;

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

function ghHeaders() {
  return { accept: 'application/vnd.github+json', 'user-agent': 'qq-agent-plus-console' };
}

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
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
 * git ls-remote 兜底探测（不拉取对象），沿用自动更新的网络设置。
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
      resolve({ ok: true, latencyMs, revision, source: 'git' });
    });
  });
}

/** 取目标分支的最新 revision：GitHub API 优先，git ls-remote 兜底。 */
export async function fetchRemoteRevision(repository, branch, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const slug = parseGithubRepo(repository);
  if (slug) {
    try {
      const data = await fetchJson(
        `https://api.github.com/repos/${slug.owner}/${slug.repo}/commits/${encodeURIComponent(branch)}`,
        fetchImpl
      );
      const revision = cleanText(data?.sha, REVISION_LENGTH);
      if (revision) return { ok: true, revision, source: 'api' };
    } catch { /* 落到 git 兜底 */ }
  }
  return probeRemoteRevision(repository, branch, options.settings || {}, { execFileImpl: options.execFileImpl });
}

/** 取 GitHub 最新 Release（公开仓库无需令牌）；失败返回 null，不抛出。 */
export async function fetchLatestRelease(repository, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const slug = parseGithubRepo(repository);
  if (!slug) return null;
  try {
    const data = await fetchJson(
      `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases/latest`,
      fetchImpl
    );
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

/** 比较 部署基线..目标 之间的提交差集（本次更新实际会带来的改动）。 */
export async function fetchComparison(repository, base, head, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const slug = parseGithubRepo(repository);
  if (!slug || !base || !head) return { ok: false, commits: [] };
  try {
    const data = await fetchJson(
      `https://api.github.com/repos/${slug.owner}/${slug.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      fetchImpl
    );
    if (!data || !Array.isArray(data.commits)) return { ok: false, commits: [] };
    const commits = data.commits
      .map((item) => ({
        sha: cleanText(item?.sha, REVISION_LENGTH),
        subject: cleanText(item?.commit?.message, 200).split('\n')[0].trim()
      }))
      .filter((item) => item.sha && item.subject)
      // GitHub 按时间正序返回；展示时让最新的在最上面。
      .reverse();
    return { ok: true, commits, total: Number(data.total_commits) || commits.length, status: String(data.status || '') };
  } catch {
    return { ok: false, commits: [] };
  }
}

/** 解析某个 ref（如 release 的 tag）指向的提交 sha；查不到返回 ''。 */
export async function fetchCommitSha(repository, ref, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const slug = parseGithubRepo(repository);
  if (!slug || !ref) return '';
  try {
    const data = await fetchJson(
      `https://api.github.com/repos/${slug.owner}/${slug.repo}/commits/${encodeURIComponent(ref)}`,
      fetchImpl
    );
    return cleanText(data?.sha, REVISION_LENGTH);
  } catch {
    return '';
  }
}

/** 没有发布说明时的兜底：把最近若干提交标题列成要点。 */
export async function fetchRecentCommitSubjects(repository, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const slug = parseGithubRepo(repository);
  if (!slug) return '';
  try {
    const data = await fetchJson(
      `https://api.github.com/repos/${slug.owner}/${slug.repo}/commits?per_page=${COMMIT_FALLBACK_COUNT}`,
      fetchImpl
    );
    if (!Array.isArray(data)) return '';
    const subjects = data
      .map((item) => cleanText(item?.commit?.message, 200).split('\n')[0].trim())
      .filter(Boolean)
      .slice(0, COMMIT_FALLBACK_COUNT);
    return subjects.map((subject) => `- ${subject}`).join('\n');
  } catch {
    return '';
  }
}

/**
 * 检查是否有新版本。成功结果缓存 30 分钟；部署基线变化（例如刚更新完）立即失效；
 * 连不上 GitHub 时不写缓存，下次打开控制台会重试。
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
  const fresh = previous && Number(previous.checkedAt) > 0
    && now - Number(previous.checkedAt) < CHECK_TTL_MS;
  const baselineUnchanged = previous && String(previous.deployed || '') === String(deployedNow || '');
  if (!force && fresh && baselineUnchanged) {
    return { ...previous, cached: true };
  }

  const probe = await fetchRemoteRevision(repository, branch, { fetchImpl, execFileImpl, settings });
  if (!probe.ok) {
    // 不缓存失败：checkedAt 记 0，下一次检查重新尝试
    const notice = {
      available: false, reason: 'unreachable', repository, branch,
      revision: '', deployed: deployedNow,
      version: '', name: '', body: '', publishedAt: 0, url: '',
      checkedAt: 0, error: probe.error || '连不上 GitHub'
    };
    writeAutoUpdateState(dataDir, { updateNotice: notice });
    return notice;
  }

  const available = Boolean(deployedNow) && probe.revision !== deployedNow;
  let release = null;
  let releaseInDelta = false;
  let body = '';
  let commitCount = 0;
  if (available) {
    // 更新目标是分支最新提交：主体内容用「部署基线..目标」的提交差集，
    // Release 说明只在它本身也落在这次差集里时才附上（否则是过期的旧发行说明）。
    const compare = await fetchComparison(repository, deployedNow, probe.revision, { fetchImpl });
    if (compare.ok) {
      commitCount = compare.commits.length;
      body = compare.commits.map((item) => `- ${item.subject}`).join('\n');
    }
    release = await fetchLatestRelease(repository, { fetchImpl });
    if (release?.version) {
      const releaseSha = await fetchCommitSha(repository, release.version, { fetchImpl });
      releaseInDelta = Boolean(releaseSha) && compare.ok
        && compare.commits.some((item) => item.sha === releaseSha);
    }
    if (releaseInDelta && release?.body) {
      body = `【${release.version} 发布说明】\n${release.body}\n\n【本次包含的提交】\n${body}`;
    }
    if (!body) body = await fetchRecentCommitSubjects(repository, { fetchImpl });
  }
  const notice = {
    available,
    reason: deployedNow ? '' : 'unknown-deployed',
    repository,
    branch,
    revision: cleanText(probe.revision, REVISION_LENGTH),
    deployed: deployedNow,
    version: available
      ? (releaseInDelta && release?.version
        ? release.version
        : cleanText(probe.revision, REVISION_LENGTH).slice(0, 7))
      : '',
    name: releaseInDelta ? (release?.name || '') : '',
    body,
    commitCount,
    publishedAt: releaseInDelta ? (release?.publishedAt || 0) : 0,
    url: releaseInDelta ? (release?.url || '') : '',
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
