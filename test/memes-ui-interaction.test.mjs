import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

const window = new Window();
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;

const { bindExtensionSettings, renderMemesSection } = await import('../ui/pages/settings-extensions.js');

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

test('会话选择器：点选/取消、搜索筛选、筛选结果全选、清空', () => {
  const ui = mount();
  ui.option('group:123').click();
  ui.option('private:789').click();
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

test('没有群/私聊时不渲染选择器，但保留手动输入入口', () => {
  document.body.innerHTML = renderMemesSection({ allow: { groups: [], private: [] } });
  bindExtensionSettings();
  assert.equal(document.querySelector('.meme-chat-option'), null);
  assert.ok(document.querySelector('#meme-chatkey-manual'));
});
