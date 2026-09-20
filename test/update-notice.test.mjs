import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-notice-'));
process.env.QQ_AGENT_DATA_DIR = root;

const {
  parseGithubRepo, checkForUpdate, ignoreVersion, fetchRemoteRevision
} = await import('../src/update-notice.js');
const { readAutoUpdateState } = await import('../src/auto-update.js');

after(() => fs.rmSync(root, { recursive: true, force: true }));

const CONFIG = {
  autoUpdate: {
    repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
    branch: 'main',
    connectivityTimeoutSeconds: 5,
    forceHttp11: true
  }
};
const DEPLOYED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REMOTE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RELEASE_SHA = 'cccccccccccccccccccccccccccccccccccccccc';
// 与 GitHub compare 一致：按时间正序（最早的在前），客户端展示时反转成"最新在上"。
const DELTA_COMMITS = [
  { sha: 'dddddddddddddddddddddddddddddddddddddddd', subject: '更早的一个提交' },
  { sha: RELEASE_SHA, subject: '发布了 v9.9.9' },
  { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', subject: '最新的一个提交' }
];
const RELEASE = {
  tag_name: 'v9.9.9',
  name: 'v9.9.9 —— 测试版本',
  body: '- 新增了某某功能\n- 修了某某问题',
  published_at: '2026-09-20T00:00:00Z',
  html_url: 'https://example.com/release'
};

function caseDir(deployed = DEPLOYED) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  if (deployed) fs.writeFileSync(path.join(dir, 'deployed-revision'), `${deployed}\n`);
  return dir;
}

/** 假的 GitHub：按 URL 路由到 compare / commits(单个) / commits 列表 / releases。 */
function fakeGitHub({
  remoteRevision = REMOTE,
  release = RELEASE,
  releaseSha = RELEASE_SHA,
  compareCommits = DELTA_COMMITS,
  compareOk = true,
  recentSubjects = ['最近的兜底提交一', '最近的兜底提交二']
} = {}) {
  const impl = async (url) => {
    const target = String(url);
    impl.calls.push(target);
    if (/\/compare\//.test(target)) {
      if (!compareOk) return { ok: false, json: async () => null };
      return {
        ok: true,
        json: async () => ({
          status: 'ahead',
          total_commits: compareCommits.length,
          commits: compareCommits.map((item) => ({ sha: item.sha, commit: { message: `${item.subject}\n\n细节` } }))
        })
      };
    }
    if (/\/commits\?per_page=/.test(target)) {
      return {
        ok: true,
        json: async () => recentSubjects.map((subject, index) => ({
          sha: `e${index}`, commit: { message: `${subject}\n\n细节` }
        }))
      };
    }
    if (/\/commits\//.test(target)) {
      const ref = decodeURIComponent(target.split('/commits/')[1] || '');
      if (ref === 'main' || ref === 'refs/heads/main') {
        return remoteRevision
          ? { ok: true, json: async () => ({ sha: remoteRevision }) }
          : { ok: false, json: async () => null };
      }
      if (ref === (release?.tag_name || '')) {
        return releaseSha ? { ok: true, json: async () => ({ sha: releaseSha }) } : { ok: false, json: async () => null };
      }
      return { ok: false, json: async () => null };
    }
    if (/\/releases\/latest/.test(target)) {
      return release ? { ok: true, json: async () => release } : { ok: false, json: async () => null };
    }
    return { ok: false, json: async () => null };
  };
  impl.calls = [];
  return impl;
}

function fakeExec(revision) {
  const impl = (cmd, args, opts, cb) => {
    impl.calls += 1;
    if (revision == null) cb(new Error('unable to access'), '', 'fatal: unable to access');
    else cb(null, `${revision}\trefs/heads/main\n`, '');
  };
  impl.calls = 0;
  return impl;
}

test('parses GitHub repository slugs', () => {
  assert.deepEqual(parseGithubRepo('https://github.com/a/b.git'), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseGithubRepo('https://github.com/a/b'), { owner: 'a', repo: 'b' });
  assert.equal(parseGithubRepo('https://gitlab.com/a/b'), null);
  assert.equal(parseGithubRepo(''), null);
});

test('lists the commits between the deployed baseline and the target, release notes only when inside the delta', async () => {
  const dir = caseDir();
  const github = fakeGitHub();
  const notice = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });

  assert.equal(notice.available, true);
  assert.equal(notice.version, 'v9.9.9', 'Release 落在差集里时用 tag 当版本号');
  assert.equal(notice.commitCount, DELTA_COMMITS.length);
  assert.match(notice.body, /【v9\.9\.9 发布说明】/, '包含发布说明');
  assert.match(notice.body, /最新的一个提交/, '包含提交说明');
  assert.match(notice.body, /更早的一个提交/);
  // 最新提交在最上面
  assert.ok(notice.body.indexOf('最新的一个提交') < notice.body.indexOf('更早的一个提交'));
  const state = readAutoUpdateState(dir);
  assert.equal(state.updateNotice.available, true);
  assert.equal(state.updateNotice.version, 'v9.9.9');
});

test('uses the short target revision as version when no release is inside the delta', async () => {
  const dir = caseDir();
  // Release 指向的提交不在差集里（例如只是旧发行版）→ 只列提交，版本号用短 sha
  const github = fakeGitHub({ releaseSha: 'ffffffffffffffffffffffffffffffffffffffff' });
  const notice = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });

  assert.equal(notice.available, true);
  assert.equal(notice.version, REMOTE.slice(0, 7));
  assert.equal(notice.name, '');
  assert.equal(notice.commitCount, DELTA_COMMITS.length);
  assert.doesNotMatch(notice.body, /发布说明/);
  assert.match(notice.body, /最新的一个提交/);
});

test('falls back to recent commit subjects when the comparison is unavailable', async () => {
  const dir = caseDir();
  const github = fakeGitHub({ compareOk: false });
  const notice = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });

  assert.equal(notice.available, true);
  assert.equal(notice.version, REMOTE.slice(0, 7));
  assert.match(notice.body, /最近的兜底提交一/);
  assert.equal(github.calls.filter((u) => /\/commits\?per_page=/.test(u)).length, 1);
});

test('treats identical revisions as up to date and serves cached results', async () => {
  const dir = caseDir(REMOTE);
  const github = fakeGitHub();
  const first = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });
  assert.equal(first.available, false);
  assert.equal(github.calls.filter((u) => /\/compare\//.test(u)).length, 0, '已是最新时不应比较差集');
  assert.equal(github.calls.filter((u) => /releases\/latest/.test(u)).length, 0, '已是最新时不应查询 Release');
  const probeCalls = github.calls.length;

  const second = await checkForUpdate(dir, CONFIG, { fetchImpl: github, now: Number(first.checkedAt) + 60_000 });
  assert.equal(second.cached, true);
  assert.equal(github.calls.length, probeCalls, '缓存命中时不应再次请求 GitHub');
});

test('cache invalidates once the deployed baseline moves', async () => {
  const dir = caseDir();
  const github = fakeGitHub();
  const first = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });
  assert.equal(first.available, true);
  const probeCalls = github.calls.length;

  fs.writeFileSync(path.join(dir, 'deployed-revision'), `${REMOTE}\n`);
  const second = await checkForUpdate(dir, CONFIG, { fetchImpl: github, now: Number(first.checkedAt) + 60_000 });
  assert.equal(second.cached, undefined);
  assert.equal(second.available, false);
  assert.ok(github.calls.length > probeCalls);
});

test('unreachable GitHub degrades silently and is never cached', async () => {
  const dir = caseDir();
  const github = fakeGitHub({ remoteRevision: null });
  const exec = fakeExec(null);
  const first = await checkForUpdate(dir, CONFIG, { fetchImpl: github, execFileImpl: exec, force: true });
  assert.equal(first.available, false);
  assert.equal(first.reason, 'unreachable');
  assert.match(String(first.error), /unable to access/);
  assert.equal(first.checkedAt, 0, '失败不写缓存时间戳');
  assert.equal(exec.calls, 1, 'API 失败后应尝试 git 兜底');

  const callsAfterFirst = github.calls.length;
  const second = await checkForUpdate(dir, CONFIG, { fetchImpl: github, execFileImpl: exec });
  assert.equal(second.cached, undefined);
  assert.ok(github.calls.length > callsAfterFirst, '失败后下一次打开控制台应重试');
});

test('ignores exactly one version at a time', () => {
  const dir = caseDir();
  assert.equal(ignoreVersion(dir, 'v9.9.9'), 'v9.9.9');
  assert.equal(readAutoUpdateState(dir).ignoredVersion, 'v9.9.9');
  assert.equal(ignoreVersion(dir, ''), '', '空版本号不写入');
  assert.equal(readAutoUpdateState(dir).ignoredVersion, 'v9.9.9');
});
