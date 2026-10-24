import assert from 'node:assert/strict';
import { test } from 'node:test';

// 缺 happy-dom 时自动跳过（D6 约定：更新器环境是 npm ci --omit=dev，devDependencies 不装）
let Window = null;
try {
  ({ Window } = await import('happy-dom'));
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
const SKIP = Window ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';
const it = (name, fn) => (SKIP ? test.skip(name, { skip: SKIP }, fn) : test(name, fn));

const window = new Window();
globalThis.window = window;
const document = globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;

const { bindExtensionSettings, hydrateExtensionStatus, renderMemesSection } = await import('../ui/pages/settings-extensions.js');

function mount() {
  document.body.innerHTML = renderMemesSection({
    allow: { groups: ['123', '456'], private: ['789'] }
  });
  bindExtensionSettings();
  return {
    option: (id) => document.querySelector(`.meme-chat-option[data-chatkey="${id}"]`),
    count: () => document.querySelector('#memes-selected-count')?.textContent || '',
    chips: () => [...document.querySelectorAll('.meme-chat-chip')].length
  };
}

it('会话选择器：点选/取消、搜索筛选、筛选结果全选、清空', () => {
  const ui = mount();
  const check = (id) => ui.option(id).querySelector('input');
  check('group:123').click();
  check('private:789').click();
  assert.equal(ui.count(), '已选 2 个');
  assert.equal(ui.chips(), 2);

  const search = document.querySelector('#memes-chat-search');
  search.value = '456';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(ui.option('group:123').hidden, true, '搜索后不匹配的会话隐藏');
  assert.equal(ui.option('group:456').hidden, false);

  document.querySelector('#memes-clear-selected').click();
  assert.equal(ui.count(), '已选 0 个');
  document.querySelector('#memes-select-visible').click();
  assert.equal(ui.count(), '已选 1 个', '只选中当前筛选结果');

  document.querySelector('.meme-chat-chip-remove').click();
  assert.equal(ui.count(), '已选 0 个', '点标签上的 × 能取消');
});

it('没有群/私聊时不渲染选择器，但保留手动输入入口', () => {
  document.body.innerHTML = renderMemesSection({ allow: { groups: [], private: [] } });
  bindExtensionSettings();
  assert.equal(document.querySelector('.meme-chat-option'), null);
  assert.ok(document.querySelector('#meme-chatkey-manual'));
});

it('已有梗库列表加载：GET /api/memes 的 entries 数组会渲染到列表', async () => {
  document.body.innerHTML = renderMemesSection({ allow: { groups: ['123'], private: [] } });
  bindExtensionSettings();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, entries: [{ id: 'm1', chatKey: 'group:123', term: '测试梗', meaning: '测试含义', usage: '', aliases: [] }], count: 1 })
  });
  try {
    await hydrateExtensionStatus();
    const html = document.querySelector('#memes-list')?.innerHTML || '';
    assert.match(html, /测试梗/);
    assert.match(html, /测试含义/);
    assert.match(html, /data-id="m1"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
