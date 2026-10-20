// 控制台布局契约（2026-10-19 UI 审查）：
//   · 人设身份区四字段同排，提示统一放在行下方（不能只挂在机器人名字下面）
//   · 按群人设会话多时用多列卡片网格，不再一列拉到底
//   · 表单统一「标签在上、控件在下」；不再有"无 hint 字段改标签左"的全局规则
//   · 时间范围行与全站控件同高
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const persona = fs.readFileSync(new URL('../ui/pages/persona.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8');

test('人设身份区：四字段同排，提示统一在行下方', () => {
  assert.match(persona, /class="field-row persona-identity-row"/);
  assert.match(persona, /class="hint persona-identity-hint"/);
  assert.doesNotMatch(persona, /id="cfg-botname"[\s\S]{0,160}<div class="hint">/,
    '提示不能只挂在机器人名字下面：同一行其余字段没有提示会显得突兀');
});

test('按群人设：会话多时用多列卡片网格', () => {
  assert.match(css, /\.per-chat-list \{[^}]*display: grid;/);
  assert.match(css, /\.per-chat-list \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(300px, 1fr\)\)/);
  assert.match(css, /\.per-chat-row \{[^}]*grid-template-columns: minmax\(0, \.9fr\) minmax\(140px, 1\.1fr\)/);
});

test('表单统一标签在上：不再有「无 hint 字段改标签左」的全局规则', () => {
  assert.doesNotMatch(css, /\.field:not\(:has\(\.hint\)\):not\(:has\(> label\.checkbox-row\)\) \{/,
    '标签左/控件右会让同一行的文本框换行、下拉留在原行，两种标签位置');
  assert.match(css, /\.field > select \{ max-width: 380px; \}/);
});

test('时间范围行与全站控件同高', () => {
  assert.match(css, /\.moment-window-row input \{[^}]*height: 40px/);
  assert.match(css, /\.moment-window-remove \{ width: 40px; height: 40px;/);
});
