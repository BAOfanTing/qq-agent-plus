import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-dx-'));
process.env.QQ_AGENT_DATA_DIR = path.join(root, 'appdata');
const { parsePluginManifest } = await import('../src/plugins/manifest.js');
const { createCapabilities } = await import('../src/plugins/capabilities.js');
const { CAP_METHODS } = await import('../src/plugins/protocol.js');

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('plugin-create --api-version 2：生成可校验的 v2 骨架（settings/http/写动作）', () => {
  const run = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'plugin-create.mjs'), 'demo-dx', '--api-version', '2', '--dir', root
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const dir = path.join(root, 'demo-dx');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
  const checked = parsePluginManifest(raw, { dir });
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.manifest.apiVersion, 2);
  for (const capability of ['config', 'http', 'storage', 'approval', 'quota']) {
    assert.ok(checked.manifest.capabilities.includes(capability), capability);
  }
  assert.deepEqual(raw.httpDomains, ['api.example.com']);
  assert.equal(raw.approvals[0].action, 'write');
  assert.ok(raw.tools.some((tool) => tool.name === 'write_demo' && tool.action === 'write'));
  assert.equal(fs.existsSync(path.join(dir, 'dev-settings.json')), true);

  const validate = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'plugin-validate.mjs'), dir
  ], { encoding: 'utf8' });
  assert.equal(validate.status, 0, validate.stderr || validate.stdout);
  assert.match(validate.stdout, /demo-dx v0\.1\.0/);
  assert.match(validate.stdout, /写动作/);
});

test('插件磁盘配额：storage 写入超过 limits.diskMb 时拒绝（E_DISK_QUOTA）', () => {
  const dataDir = path.join(root, 'quota-data');
  const caps = createCapabilities({
    pluginId: 'demo-dx',
    dataDir,
    manifest: { id: 'demo-dx', capabilities: ['storage'] },
    limits: { diskMb: 0.01 }
  });
  assert.throws(
    () => caps.methods[CAP_METHODS.storageSet]({ key: 'big', value: 'x'.repeat(20000) }),
    (error) => error.code === 'E_DISK_QUOTA'
  );
});

test('插件并发上限与磁盘上限有默认值，且控制台可保存', async () => {
  const { DEFAULT_CONFIG } = await import('../src/core/config.js');
  assert.equal(DEFAULT_CONFIG.plugins.limits.concurrency, 4);
  assert.equal(DEFAULT_CONFIG.plugins.limits.diskMb, 256);
  const platform = fs.readFileSync(path.join(ROOT, 'ui/pages/platform.js'), 'utf8');
  assert.match(platform, /cfg-plugin-concurrency/);
  assert.match(platform, /cfg-plugin-disk/);
  const save = fs.readFileSync(path.join(ROOT, 'ui/pages/settings-save.js'), 'utf8');
  assert.match(save, /concurrency: numKeep/);
  assert.match(save, /diskMb: numKeep/);
});
