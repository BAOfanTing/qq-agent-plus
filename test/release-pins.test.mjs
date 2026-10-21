// 发版版本号必须与 compose/README 的默认镜像 pin 一致：否则 tag/package 校验通过，
// `docker compose up -d` 仍拉旧版本，用户以为升级了其实没有。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const compose = fs.readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8');
const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
const dockerDoc = fs.readFileSync(path.join(repo, 'docs/DOCKER.md'), 'utf8');

test('compose 默认 Agent 镜像 tag 与 package.json 版本一致', () => {
  assert.match(compose, new RegExp(`wangxinhong/qq-agent-plus:${pkg.version.replace(/\./g, '\\.')}`));
});

test('Docker 手动发布也会校验版本号', () => {
  const docker = fs.readFileSync(path.join(repo, '.github/workflows/docker.yml'), 'utf8');
  assert.match(docker, /手动发布版本与 package\.json 一致/);
  assert.match(docker, /手动发布版本 .* package\.json 版本/);
});

test('README / DOCKER 文档的拉取示例与 package.json 版本一致', () => {
  assert.match(readme, new RegExp(`qq-agent-plus:${pkg.version.replace(/\./g, '\\.')}`));
  assert.match(dockerDoc, new RegExp(`qq-agent-plus:${pkg.version.replace(/\./g, '\\.')}`));
});
