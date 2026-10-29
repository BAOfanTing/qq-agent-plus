import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 兜底模型的 Key 必须和"存它时的服务商主机"绑定：
// 换地址不重填 Key 时，保存要被拒绝、运行期也绝不能把旧 Key 发给新主机。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-fallback-key-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } });

const { DEFAULT_CONFIG, getConfig, setRuntimeConfig, updateConfig } = await import('../src/core/config.js');
const { chatCompletionWithRetry } = await import('../src/llm/llm.js');

const reset = () => setRuntimeConfig(structuredClone(DEFAULT_CONFIG));

function saveFallback({ baseUrl = 'https://backup.example.com/v1', key = 'BACKUP-KEY', model = 'backup-model', enabled = true } = {}) {
  updateConfig({
    api: {
      baseUrl: 'https://primary.example.com/v1',
      apiKey: 'PRIMARY-KEY',
      model: 'primary-model',
      fallback: { enabled, baseUrl, apiKey: key, model }
    }
  });
  return getConfig().api.fallback;
}

test('保存兜底 Key 时按目标地址写入归属钉', () => {
  reset();
  const fb = saveFallback();
  assert.equal(fb.apiKey, 'BACKUP-KEY');
  assert.equal(fb.apiKeyHost, 'backup.example.com');
});

test('同一主机换路径不算换家，Key 继续可用', () => {
  reset();
  saveFallback();
  updateConfig({ api: { fallback: { baseUrl: 'https://backup.example.com/v2' } } });
  const fb = getConfig().api.fallback;
  assert.equal(fb.apiKey, 'BACKUP-KEY');
  assert.equal(fb.apiKeyHost, 'backup.example.com');
});

test('换兜底主机却没重填 Key：保存直接拒绝', () => {
  reset();
  saveFallback();
  assert.throws(
    () => updateConfig({ api: { fallback: { baseUrl: 'https://other.example.com/v1' } } }),
    /re-enter it after changing the base URL/
  );
  assert.equal(getConfig().api.fallback.baseUrl, 'https://backup.example.com/v1', '被拒绝的保存不能改动配置');
});

test('换主机并重填 Key：归属钉跟到新主机', () => {
  reset();
  saveFallback();
  updateConfig({ api: { fallback: { baseUrl: 'https://other.example.com/v1', apiKey: 'NEW-KEY' } } });
  const fb = getConfig().api.fallback;
  assert.equal(fb.apiKey, 'NEW-KEY');
  assert.equal(fb.apiKeyHost, 'other.example.com');
});

test('启用兜底但没有模型 id：保存拒绝', () => {
  reset();
  assert.throws(
    () => updateConfig({ api: { fallback: { enabled: true, baseUrl: 'https://backup.example.com/v1', apiKey: 'K', model: '' } } }),
    /api\.fallback\.model is required/
  );
});

test('跨服务商却没配独立 Key：保存拒绝（绝不沿用主渠道 Key）', () => {
  reset();
  assert.throws(
    () => updateConfig({ api: { baseUrl: 'https://primary.example.com/v1', fallback: { enabled: true, baseUrl: 'https://backup.example.com/v1', model: 'backup-model' } } }),
    /api\.fallback\.apiKey is required/
  );
});

test('运行期：绑定正确时用兜底 Key 请求备用主机', async (t) => {
  reset();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const seen = [];
  globalThis.fetch = async (url, request) => {
    const href = String(url);
    seen.push({ href, auth: String(request?.headers?.authorization || '') });
    if (href.includes('primary.example.com')) return Response.json({ error: { message: 'overloaded' } }, { status: 503 });
    return Response.json({ choices: [{ message: { content: 'from-backup' } }] });
  };
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api.baseUrl = 'https://primary.example.com/v1';
  cfg.api.apiKey = 'PRIMARY-KEY';
  cfg.api.model = 'primary-model';
  cfg.api.fallback = {
    enabled: true, baseUrl: 'https://backup.example.com/v1', model: 'backup-model',
    apiKey: 'BACKUP-KEY', apiKeyHost: 'backup.example.com'
  };
  setRuntimeConfig(cfg);
  const res = await chatCompletionWithRetry({ messages: [{ role: 'user', content: 'hi' }] }, 0);
  assert.match(String(res.message?.content || ''), /from-backup/);
  const backupCall = seen.find((s) => s.href.includes('backup.example.com'));
  assert.ok(backupCall, '应请求备用主机');
  assert.match(backupCall.auth, /BACKUP-KEY/);
});

test('运行期：Key 绑在旧主机时，即使字段里还有旧 Key 也不切兜底', async (t) => {
  reset();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const seen = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    seen.push(href);
    if (href.includes('primary.example.com')) return Response.json({ error: { message: 'overloaded' } }, { status: 503 });
    return Response.json({ choices: [{ message: { content: 'should-not-happen' } }] });
  };
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api.baseUrl = 'https://primary.example.com/v1';
  cfg.api.apiKey = 'PRIMARY-KEY';
  cfg.api.model = 'primary-model';
  cfg.api.fallback = {
    enabled: true, baseUrl: 'https://other.example.com/v1', model: 'backup-model',
    apiKey: 'OLD-BACKUP-KEY', apiKeyHost: 'backup.example.com'
  };
  setRuntimeConfig(cfg);
  await assert.rejects(
    chatCompletionWithRetry({ messages: [{ role: 'user', content: 'hi' }] }, 0),
    /503/
  );
  assert.ok(!seen.some((href) => href.includes('other.example.com')), '旧 Key 绝不能发到新主机');
});
