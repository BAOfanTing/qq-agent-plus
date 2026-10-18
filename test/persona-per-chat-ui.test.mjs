// 按群人设控制台侧的守卫：入口、行结构、保存语义。
// 重点钉两件事：整份替换（才能删行）与"换卡时保留附加规则等非卡字段"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('人设页有「按群人设」区块，行按会话渲染并可选择卡', () => {
  const js = read('ui/pages/persona.js');
  assert.ok(js.includes('id="persona-per-chat"'), '要有区块锚点');
  assert.ok(js.includes('data-per-chat="${esc(key)}"'), '每行带 chatKey');
  assert.ok(js.includes('class="per-chat-select"'), '每行一个选卡下拉');
  assert.ok(js.includes('跟随全局'), '要能改回跟随全局');
  assert.ok(js.includes('聊天白名单'), '没有行时提示先去白名单添加');
});

test('保存按群人设：整份替换 + 换卡保留非卡字段 + 自定义卡带上规则', () => {
  const js = read('ui/pages/settings-save.js');
  assert.ok(js.includes('patch.personaPerChat = { __replace__: perChat };'),
    '要用 __replace__ 才能把"改回跟随全局"的行真正删掉');
  assert.ok(js.includes('const keepOthers = old && typeof old === \'object\' ? { ...old } : {};'),
    '换卡要保留 customRules / botName / selfNickname / participation 等非卡字段');
  assert.ok(js.includes('delete keepOthers.roleText;'), '换卡时旧正文必须清掉（否则会盖住新卡）');
  assert.ok(js.includes('if (tpl.customRules) perChat[key].customRules = tpl.customRules;'),
    '自定义卡自带的附加规则要跟过来');
  assert.ok(js.includes('if (picked === \'keep\')'), '未知卡/自定义正文要能原样保留');
});
