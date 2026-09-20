import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-notice-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { parseGithubRepo, checkForUpdate, ignoreVersion } = await import('../src/update-notice.js');
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

function fakeExec(revision) {
  const impl = (cmd, args, opts, cb) => {
    impl.calls += 1;
    if (revision == null) cb(new Error('unable to access'), '', 'fatal: unable to access');
    else cb(null, `${revision}\trefs/heads/main\n`, '');
  };
  impl.calls = 0;
  return impl;
}

function fakeFetch(payload) {
  const impl = async () => {
    impl.calls += 1;
    if (!payload) return { ok: false, json: async () => null };
    return { ok: true, json: async () => payload };
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
  const exec = fakeExec(REMOTE);
  const fetchImpl = fakeFetch(RELEASE);
  const notice = await checkForUpdate(dir, CONFIG, { execFileImpl: exec, fetchImpl, force: true });

  assert.equal(notice.available, true);
  assert.equal(notice.version, 'v9.9.9');
  assert.equal(notice.deployed, DEPLOYED);
  assert.equal(notice.revision, REMOTE);
  assert.match(notice.body, /新增了某某功能/);
  assert.equal(fetchImpl.calls, 1);
  // 持久化到状态文件
  const state = readAutoUpdateState(dir);
  assert.equal(state.updateNotice.available, true);
  assert.equal(state.updateNotice.version, 'v9.9.9');
});

test('treats identical revisions as up to date and serves cached results', async () => {
  const dir = caseDir(REMOTE);
  const exec = fakeExec(REMOTE);
  const fetchImpl = fakeFetch(RELEASE);
  const first = await checkForUpdate(dir, CONFIG, { execFileImpl: exec, fetchImpl, force: true });
  assert.equal(first.available, false);
  assert.equal(fetchImpl.calls, 0, '已是最新时不应查询 Release');

  const second = await checkForUpdate(dir, CONFIG, {
    execFileImpl: exec, fetchImpl, now: Number(first.checkedAt) + 60_000
  });
  assert.equal(second.cached, true);
  assert.equal(exec.calls, 1, '缓存命中时不应再次探测远端');
});

test('cache invalidates once the deployed baseline moves', async () => {
  const dir = caseDir();
  const exec = fakeExec(REMOTE);
  const fetchImpl = fakeFetch(RELEASE);
  const first = await checkForUpdate(dir, CONFIG, { execFileImpl: exec, fetchImpl, force: true });
  assert.equal(first.available, true);
  assert.equal(exec.calls, 1);

  // 部署基线变化（例如刚刚更新成功）后，即使还在缓存窗口也要重新检查
  fs.writeFileSync(path.join(dir, 'deployed-revision'), `${REMOTE}\n`);
  const second = await checkForUpdate(dir, CONFIG, {
    execFileImpl: exec, fetchImpl, now: Number(first.checkedAt) + 60_000
  });
  assert.equal(second.cached, undefined);
  assert.equal(second.available, false);
  assert.equal(exec.calls, 2);
});

test('unreachable GitHub degrades silently and release fetch failure is tolerated', async () => {
  const offlineDir = caseDir();
  const offline = await checkForUpdate(offlineDir, CONFIG, {
    execFileImpl: fakeExec(null), fetchImpl: fakeFetch(RELEASE), force: true
  });
  assert.equal(offline.available, false);
  assert.equal(offline.reason, 'unreachable');
  assert.match(String(offline.error), /unable to access/);

  const noReleaseDir = caseDir();
  const noRelease = await checkForUpdate(noReleaseDir, CONFIG, {
    execFileImpl: fakeExec(REMOTE), fetchImpl: fakeFetch(null), force: true
  });
  assert.equal(noRelease.available, true);
  assert.equal(noRelease.version, '');
  assert.equal(noRelease.body, '');
});

test('ignores exactly one version at a time', () => {
  const dir = caseDir();
  assert.equal(ignoreVersion(dir, 'v9.9.9'), 'v9.9.9');
  assert.equal(readAutoUpdateState(dir).ignoredVersion, 'v9.9.9');
  assert.equal(ignoreVersion(dir, ''), '', '空版本号不写入');
  assert.equal(readAutoUpdateState(dir).ignoredVersion, 'v9.9.9');
});
