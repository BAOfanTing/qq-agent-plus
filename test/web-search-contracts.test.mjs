// 五个搜索 provider 的**契约测试**（zhipu / bocha / baidu / deepseek / bing）。
//
// 为什么补这一组：issue #38 的秘塔 bug（地址 + 请求体 + 响应路径三处都错）之所以能潜伏到用户
// 报障，是因为它**一条用例都没有** —— 而 tavily / doubao 有契约测试，所以它们的形状一直是对的。
// 这里按同一口径把剩下的补齐：地址、请求体字段名与类型、响应路径、以及"200 里带错误码"的形态
// （zhipu 401、bocha code≠200、qianfan code/error_code、bing 命中验证页）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-search-contracts-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
for (const key of ['ZHIPU_API_KEY', 'BOCHA_API_KEY', 'BAIDU_SEARCH_API_KEY', 'DEEPSEEK_API_KEY']) delete process.env[key];
// 端口避开 Linux/Windows 临时端口段，和别的 web-search 用例并行不冲突
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ server: { port: 22501, host: '127.0.0.1' } }));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { zhipuSearch, bochaSearch, baiduSearch, deepSeekSearch, bingSearch } = await import('../src/llm/web-search.js');

const setWebSearch = (patch) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch = { ...cfg.webSearch, ...patch };
  updateConfig(cfg);
};
const stub = (responder) => {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    return responder(calls.length, calls[calls.length - 1]);
  };
  return calls;
};

test('智谱：{search_engine, search_query, count} → search_result[]（title/link/content）', async () => {
  setWebSearch({ provider: 'zhipu', zhipu: { apiKey: 'zk', engine: 'search_pro', count: 12 } });
  const calls = stub(() => ({
    ok: true,
    json: async () => ({ search_result: [
      { title: 'T', link: 'https://a.example/', content: '摘要' },
      { title: '', link: 'https://b.example/', content: '' }
    ] })
  }));
  const r = await zhipuSearch('q');
  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/web_search');
  assert.equal(calls[0].headers.authorization, 'Bearer zk');
  assert.deepEqual(calls[0].body, { search_engine: 'search_pro', search_query: 'q', count: 12 });
  assert.equal(r.results[0].title, 'T');
  assert.equal(r.results[0].url, 'https://a.example/');
  assert.equal(r.results[0].snippet, '摘要');
  assert.equal(r.results[1].title, '（无标题）', '空标题要兜底');
});

test('博查：{query, count, freshness, summary} → data.webPages.value[]（name/url/snippet）', async () => {
  setWebSearch({ provider: 'bocha', bocha: { apiKey: 'bk', count: 5 } });
  const calls = stub(() => ({
    ok: true,
    json: async () => ({ code: 200, data: { webPages: { value: [
      { name: '标题', url: 'https://a.example/', snippet: '摘' },
      { name: '只有 summary', url: 'https://b.example/', summary: '摘要兜底' },
      { name: '无链接' }
    ] } } })
  }));
  const r = await bochaSearch('q');
  assert.equal(calls[0].url, 'https://api.bochaai.com/v1/web-search');
  assert.deepEqual(calls[0].body, { query: 'q', count: 5, freshness: 'noLimit', summary: false });
  assert.deepEqual(r.results.map((x) => x.url), ['https://a.example/', 'https://b.example/'], '无 url 的丢掉');
  assert.equal(r.results[1].snippet, '摘要兜底');

  // code≠200 是错误（HTTP 仍是 200）
  stub(() => ({ ok: true, json: async () => ({ code: 403, message: '额度用完' }) }));
  await assert.rejects(() => bochaSearch('q'), /额度用完/);
});

test('百度千帆：{messages, search_source, resource_type_filter} → references[]；code/error_code 两种错误字段都认', async () => {
  setWebSearch({ provider: 'baidu', baidu: { apiKey: 'bak', count: 8 } });
  const calls = stub(() => ({
    ok: true,
    json: async () => ({ references: [{ title: 'T', url: 'https://a.example/', content: '内容' }] })
  }));
  const r = await baiduSearch('q');
  assert.equal(calls[0].url, 'https://qianfan.baidubce.com/v2/ai_search/web_search');
  assert.equal(calls[0].headers.authorization, 'Bearer bak');
  assert.deepEqual(calls[0].body, {
    messages: [{ role: 'user', content: 'q' }],
    search_source: 'baidu_search_v2',
    resource_type_filter: [{ type: 'web', top_k: 8 }]
  });
  assert.equal(r.results[0].snippet, '内容');

  stub(() => ({ ok: true, json: async () => ({ code: 216003, message: '鉴权失败' }) }));
  await assert.rejects(() => baiduSearch('q'), /216003/);
  stub(() => ({ ok: true, json: async () => ({ error_code: 17, error_msg: '日额度超限' }) }));
  await assert.rejects(() => baiduSearch('q'), /17/);
});

test('DeepSeek：Responses API（input + tools:[web_search]）→ output_text；兼容 output[].content[]', async () => {
  setWebSearch({ provider: 'deepseek', deepseek: { apiKey: 'dk', model: 'deepseek-v4-flash' } });
  const calls = stub(() => ({ ok: true, json: async () => ({ output_text: '答案' }) }));
  const r = await deepSeekSearch('q');
  assert.equal(calls[0].url, 'https://api.deepseek.com/responses');
  assert.equal(calls[0].headers.authorization, 'Bearer dk');
  assert.equal(calls[0].body.model, 'deepseek-v4-flash');
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search' }]);
  assert.equal(calls[0].body.stream, false);
  assert.match(calls[0].body.input, /q/);
  assert.equal(r.results[0].snippet, '答案');

  stub(() => ({ ok: true, json: async () => ({ output: [{ type: 'message', content: [{ text: '分块' }, { text: '文本' }] }] }) }));
  const alt = await deepSeekSearch('q');
  assert.equal(alt.results[0].snippet, '分块文本', 'output[].content[].text 拼接');
});

test('Bing：HTML 解析出 b_algo 块；命中验证页（0 块）要抛错而不是给空列表', async () => {
  setWebSearch({ provider: 'bing', searchUrl: 'https://cn.bing.com/search', maxResults: 3 });
  const html = '<ol><li class="b_algo"><h2><a href="https://a.example/">标题 A</a></h2><p>摘要 A</p></li>'
    + '<li class="b_algo"><h2><a href="https://b.example/">标题 B</a></h2><p>摘要 B</p></li>'
    + '<li class="b_algo"><h2><a href="https://c.example/">标题 C</a></h2><p>摘要 C</p></li>'
    + '<li class="b_algo"><h2><a href="https://d.example/">标题 D</a></h2><p>摘要 D</p></li></ol>';
  const calls = stub(() => ({ ok: true, text: async () => html }));
  const r = await bingSearch('测试');
  assert.match(calls[0].url, /^https:\/\/cn\.bing\.com\/search\?q=/);
  assert.equal(r.results.length, 3, 'maxResults 截断');
  assert.deepEqual(r.results.map((x) => x.url), ['https://a.example/', 'https://b.example/', 'https://c.example/']);

  stub(() => ({ ok: true, text: async () => '<html><body>请完成验证</body></html>' }));
  await assert.rejects(() => bingSearch('x'), /没有返回可解析的结果/);
});
