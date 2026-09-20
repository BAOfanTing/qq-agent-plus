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

/** 假的 GitHub：按 URL 路由到 commits / releases / commits 列表。 */
function fakeGitHub({ remoteRevision = REMOTE, release = RELEASE, commitSubjects = ['新增了某某功能', '修了某某问题'] } = {}) {
  const impl = async (url) => {
    const target = String(url);
    impl.calls.push(target);
    if (/\/commits\?per_page=/.test(target)) {
      return {
        ok: true,
        json: async () => commitSubjects.map((subject, index) => ({
          sha: `c${index}`, commit: { message: `${subject}\n\n细节` }
        }))
      };
    }
    if (/\/commits\//.test(target)) {
      return remoteRevision
        ? { ok: true, json: async () => ({ sha: remoteRevision }) }
        : { ok: false, json: async () => null };
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

test('detects a new revision and attaches the latest release notes', async () => {
  const dir = caseDir();
  const github = fakeGitHub();
  const notice = await checkForUpdate(dir, CONFIG, { fetchImpl: github, execFileImpl: fakeExec(null), force: true });

  assert.equal(notice.available, true);
  assert.equal(notice.version, 'v9.9.9');
  assert.equal(notice.deployed, DEPLOYED);
  assert.equal(notice.revision, REMOTE);
  assert.match(notice.body, /新增了某某功能/);
  assert.equal(github.calls.filter((u) => /\/commits\//.test(u) && !/\?/.test(u)).length, 1);
  assert.equal(github.calls.filter((u) => /releases\/latest/.test(u)).length, 1);
  // 持久化到状态文件
  const state = readAutoUpdateState(dir);
  assert.equal(state.updateNotice.available, true);
  assert.equal(state.updateNotice.version, 'v9.9.9');
});

test('treats identical revisions as up to date and serves cached results', async () => {
  const dir = caseDir(REMOTE);
  const github = fakeGitHub();
  const first = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });
  assert.equal(first.available, false);
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

  // 部署基线变化（例如刚刚更新成功）后，即使还在缓存窗口也要重新检查
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

test('falls back to recent commit subjects when no release body exists', async () => {
  const dir = caseDir();
  const github = fakeGitHub({ release: { ...RELEASE, body: '' } });
  const notice = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });
  assert.equal(notice.available, true);
  assert.equal(notice.version, 'v9.9.9');
  assert.match(notice.body, /- 新增了某某功能/);
  assert.equal(github.calls.filter((u) => /\/commits\?per_page=/.test(u)).length, 1);
});

test('ignores exactly one version at a time', () => {
  const dir = caseDir();
  assert.equal(ignoreVersion(dir, 'v9.9.9'), 'v9.9.9');
  assert.equal(readAutoUpdateState(dir).ignoredVersion, 'v9.9.9');
  assert.equal(ignoreVersion(dir, ''), '', '空版本号不写入');
  assert.equal(readAutoUpdateState(dir).ignoredVersion, 'v9.9.9');
});
