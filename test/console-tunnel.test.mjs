import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(repo, 'console-tunnel.sh');
const source = fs.readFileSync(file, 'utf8');
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = hasBash ? false : '需要 bash';

test('console-tunnel.sh：不依赖本地项目，能读令牌/凭据并建三条隧道', { skip }, () => {
  assert.match(source, /ssh -N/);
  assert.match(source, /-L "\$\{CONSOLE_PORT\}:127\.0\.0\.1:\$\{CONSOLE_PORT\}"/);
  assert.match(source, /-L "\$\{WEBUI_PORT\}:127\.0\.0\.1:\$\{WEBUI_PORT\}"/);
  assert.match(source, /-L "\$\{VNC_PORT\}:127\.0\.0\.1:\$\{VNC_PORT\}"/);
  assert.match(source, /console-access\.txt/);
  assert.match(source, /deployment-access\.txt/);
  assert.match(source, /TEST_OK/);
  assert.match(source, /forget/);
});

test('console-tunnel.sh：语法正确，--help 可独立运行', { skip }, () => {
  const syntax = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync('bash', [file, '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /console-tunnel/);
});
