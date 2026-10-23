import assert from 'node:assert/strict';
import { test } from 'node:test';

const { renderMemesSection } = await import('../ui/pages/settings-extensions.js');

test('梗库会话复选框：来自已添加的群/私聊白名单，可全选', () => {
  const html = renderMemesSection({
    allow: { groups: ['123', '456', '456'], private: ['789'] }
  });
  assert.equal((html.match(/class="meme-chat-check"/g) || []).length, 3, '群/私聊去重后各一个复选框');
  assert.match(html, /群 123/);
  assert.match(html, /群 456/);
  assert.match(html, /私聊 789/);
  assert.match(html, /id="memes-select-all"/);
  assert.match(html, /id="meme-chatkey-manual"/, '白名单为空时仍能手动输入会话 key');
  assert.match(html, /data-chatkey="group:123"/);
  assert.match(html, /data-chatkey="private:789"/);
});

test('白名单为空时给出提示，不渲染空复选框组', () => {
  const html = renderMemesSection({ allow: { groups: [], private: [] } });
  assert.doesNotMatch(html, /meme-chat-check/);
  assert.match(html, /还没有已添加的群聊\/私聊/);
});
