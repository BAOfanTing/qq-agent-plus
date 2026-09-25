// 控制台「发现新版本」提示：以 GitHub 上「已发布的 Release」为唯一依据做只读检查。
//
// 口径（与部署链路共用，见 scripts/auto-update.mjs）：
//   - 只有作者发布了 Release（草稿、预发布都不算）才提示；branch 上的日常提交不提示，
//     避免用户装上未经发布的中间状态。
//   - 当前部署已经包含 / 领先于最新 Release（compare 结果为 behind / identical）时提示「已是最新」。
//   - 方向未知（比较接口失败）时既不提示也不部署，等待下次检查。
//
// 本模块不做任何部署；「立即更新」仍走既有的 /api/auto-update/run 链路，
// 由它按这里判定出的 Release tag 部署。
//
// 站点数据只写入 auto-update.json 的 updateNotice / ignoredVersion 两个键，
// 与自动更新的既有字段互不影响。
import fs from 'node:fs';
import path from 'node:path';
import { readAutoUpdateState, writeAutoUpdateState } from './auto-update.js';

const CHECK_TTL_MS = 30 * 60 * 1000;
const API_TIMEOUT_MS = 10000;
const REVISION_LENGTH = 64;
const BODY_LIMIT = 8000;
const API_BASE_DEFAULT = 'https://api.github.com';

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

/**
 * GitHub API 基地址：默认 api.github.com。
 * QQ_AGENT_GITHUB_API 用于测试桩或自建镜像，普通部署不需要设置。
 */
export function githubApiBase() {
  const configured = cleanText(process.env.QQ_AGENT_GITHUB_API, 200);
  return (configured || API_BASE_DEFAULT).replace(/\/+$/, '');
}

function ghHeaders() {
  return { accept: 'application/vnd.github+json', 'user-agent': 'qq-agent-plus-console' };
}

async function fetchJson(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, {
      headers: ghHeaders(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
    if (!res.ok) return { ok: false, status: Number(res.status) || 0 };
    const data = await res.json().catch(() => null);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, status: 0, error: cleanText(error?.message, 200) };
  }
}

function httpFailure(result) {
  return result.status ? `GitHub 返回 ${result.status}` : (result.error || '请求失败');
}

/** 从仓库地址解析 GitHub owner/repo；非 github.com 返回 null。 */
export function parseGithubRepo(repository) {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)$/i.exec(String(repository || '').trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
}

function apiUrl(slug, suffix) {
  return `${githubApiBase()}/repos/${slug.owner}/${slug.repo}${suffix}`;
}

/** 部署基线：deploy.sh 写入的 data/deployed-revision，缺失时退回状态文件里的记录。 */
export function deployedRevisionAt(dataDir, state = null) {
  try {
    // deploy.sh 在源码树有未提交改动时会写 "<sha>-dirty"；带上它去调 GitHub compare 会 404，
    // 表现为更新检查永久 compare-failed（静默失效）。与 scripts/auto-update.mjs 口径一致地剥掉。
    const revision = cleanText(fs.readFileSync(path.join(dataDir, 'deployed-revision'), 'utf8'), REVISION_LENGTH)
      .replace(/-dirty$/, '');
    if (revision) return revision;
  } catch { /* 从未部署过 */ }
  return cleanText(state?.currentRevision, REVISION_LENGTH);
}

/**
 * 取 GitHub 最新 Release（公开仓库无需令牌）。
 * 只返回「已发布」的正式版本：草稿与预发布都不在 /releases/latest 里。
 * 返回 { published: false }（仓库还没有 Release）、{ published: true, release } 或 { failed: true }。
 */
export async function fetchLatestRelease(repository, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const slug = parseGithubRepo(repository);
  if (!slug) return { published: false };
  const result = await fetchJson(apiUrl(slug, '/releases/latest'), fetchImpl);
  if (!result.ok) {
    // 404 = 仓库还没有发布过 Release；其余（限流、网络、5xx）都算读取失败
    if (result.status === 404) return { published: false };
    return { failed: true, error: httpFailure(result) };
  }
  const data = result.data;
  if (!data || typeof data !== 'object' || data.draft === true || data.prerelease === true) {
    return { published: false };
  }
  return {
    published: true,
    release: {
      version: cleanText(data.tag_name, 64),
      name: cleanText(data.name, 200),
      body: cleanText(data.body, BODY_LIMIT),
      publishedAt: Date.parse(data.published_at) || 0,
      url: cleanText(data.html_url, 500)
    }
  };
}

/**
 * 比较「部署基线..发布版本」，失败时带上原因。
 * GitHub 的 status 描述的是 head 相对 base 的关系：
 * ahead = 发布版本领先（有更新）、behind / identical = 当前部署已包含该版本、
 * diverged = 两条线各自都有提交。
 */
export async function fetchComparison(repository, base, head, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const slug = parseGithubRepo(repository);
  if (!slug || !base || !head) return { ok: false, commits: [], error: '缺少比较参数' };
  const result = await fetchJson(
    apiUrl(slug, `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`),
    fetchImpl
  );
  if (!result.ok) return { ok: false, commits: [], error: httpFailure(result) };
  const data = result.data;
  if (!data || !Array.isArray(data.commits)) {
    return { ok: false, commits: [], error: '比较结果无法解析' };
  }
  const commits = data.commits
    .map((item) => ({
      sha: cleanText(item?.sha, REVISION_LENGTH),
      subject: cleanText(item?.commit?.message, 200).split('\n')[0].trim()
    }))
    .filter((item) => item.sha && item.subject)
    // GitHub 按时间正序返回；展示时让最新的在最上面。
    .reverse();
  return {
    ok: true,
    commits,
    total: Number(data.total_commits) || commits.length,
    status: String(data.status || '')
  };
}

/**
 * 检查是否有新的已发布版本。成功结果缓存 30 分钟；部署基线变化（例如刚更新完）立即失效；
 * 连不上 GitHub 或无法比较时不写缓存，下次打开控制台会重试。
 */
export async function checkForUpdate(dataDir, config = {}, { force = false, now = Date.now(), fetchImpl } = {}) {
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

  const base = {
    repository,
    branch,
    deployed: deployedNow,
    revision: '',
    version: '',
    name: '',
    body: '',
    commitCount: 0,
    publishedAt: 0,
    url: '',
    checkedAt: now,
    error: ''
  };
  const store = (notice) => {
    writeAutoUpdateState(dataDir, { updateNotice: notice });
    return notice;
  };

  const latest = await fetchLatestRelease(repository, { fetchImpl });
  if (latest.failed) {
    // 读不到 Release 列表（限流 / 网络 / 5xx）：不猜，不写缓存，下次打开控制台重试
    return store({
      ...base,
      available: false,
      reason: 'unreachable',
      checkedAt: 0,
      error: `无法读取 GitHub Releases：${latest.error}`
    });
  }
  if (!latest.published || !latest.release?.version) {
    // 仓库还没有发布过 Release：不提示（也不想让用户去装 branch 上的中间提交）
    return store({ ...base, available: false, reason: 'no-release' });
  }
  const release = latest.release;
  const releaseInfo = {
    version: release.version,
    name: release.name || '',
    body: release.body || '',
    publishedAt: release.publishedAt || 0,
    url: release.url || ''
  };

  if (!deployedNow) {
    // 部署基线不是 git 提交（例如压缩包安装），无法比较方向：不弹窗，只在面板里说明
    return store({ ...base, ...releaseInfo, available: false, reason: 'unknown-deployed' });
  }

  const compare = await fetchComparison(repository, deployedNow, release.version, { fetchImpl });
  if (!compare.ok) {
    // 方向未知：既不提示也不允许部署，且不写缓存（下次打开控制台重试）
    return store({
      ...base,
      ...releaseInfo,
      available: false,
      reason: 'compare-failed',
      checkedAt: 0,
      error: `无法比较当前版本与该 Release：${compare.error || 'GitHub 比较接口不可用'}`
    });
  }

  const status = String(compare.status || '');
  if (status === 'behind' || status === 'identical') {
    return store({
      ...base,
      ...releaseInfo,
      available: false,
      reason: status === 'behind' ? 'ahead-of-release' : ''
    });
  }

  // status 为 ahead / diverged（或未给出状态但有差异）：发布版本领先，有更新
  const commits = compare.commits.map((item) => `- ${item.subject}`).join('\n');
  const body = [
    releaseInfo.body ? `【${release.version} 发布说明】\n${releaseInfo.body}` : '',
    commits ? `【本次包含的提交】\n${commits}` : ''
  ].filter(Boolean).join('\n\n');
  return store({
    ...base,
    ...releaseInfo,
    available: true,
    reason: '',
    revision: release.version,
    body,
    commitCount: Number(compare.total) || compare.commits.length
  });
}

/** 「忽略这个版本」：只屏蔽该 Release tag；出现更新版本时照常提示。 */
export function ignoreVersion(dataDir, version) {
  const clean = cleanText(version, 64);
  if (!clean) return '';
  writeAutoUpdateState(dataDir, { ignoredVersion: clean });
  return clean;
}
