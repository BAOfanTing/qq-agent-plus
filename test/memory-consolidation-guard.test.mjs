// 记忆整理结果的采纳规则（防幻觉护栏）：
//   实测教训：模型把"喜欢掌握角色设定…扬言改人设提示词"那条改干净、拆成 4 条（原 3 条）时，
//   被老的"条数不得变多"规则整轮拒绝，好改写被旧文本顶回去。现在允许"拆一条"，
//   但仍然挡住"越整理越多、越整理越长"的编造式结果。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-guard-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.DEBUG_SERVER_URL = 'http://127.0.0.1:1/event';

const { consolidationRejectionReason } = await import('../src/core/orchestrator.js');

const existing = [
  { content: '爱问"你现在是什么人设"，也爱逗人表演，会提改人设。' },
  { content: '发言短促，爱发表情包和说说卡片。' },
  { content: '常表达想念和喜欢，在意别人偷图。' }
];

test('新建模式（从零提炼）不设条数限制', () => {
  assert.equal(consolidationRejectionReason({ isNew: true, existing: [], next: ['a', 'b', 'c', 'd', 'e'] }), '');
});

test('合并/删减（条数变少或持平）一律采纳', () => {
  assert.equal(consolidationRejectionReason({ existing, next: ['合并后的一条'] }), '');
  assert.equal(consolidationRejectionReason({ existing, next: existing.map((e) => e.content) }), '');
});

test('拆开一条（+1 条、字数没膨胀）采纳 —— 今天修好的那个坑', () => {
  const split = [
    '爱问"你现在是什么人设"，会提改人设。',
    '爱逗人表演，要喵、要摸头。',
    '发言短促，爱发表情包和说说卡片。',
    '常表达想念和喜欢，在意别人偷图。'
  ];
  assert.equal(consolidationRejectionReason({ existing, next: split }), '');
});

test('条数多出两条以上，或字数明显膨胀 → 拒绝（疑似编造）', () => {
  assert.match(consolidationRejectionReason({ existing, next: [...existing.map((e) => e.content), '新的一条', '又一条'] }), /结果变多/);
  // +1 条，但每条都塞满字数（总字数翻了倍）也算编造
  const bloated = [...existing.map((e) => e.content), '这条凭空多出来的印象'.repeat(6)];
  assert.match(consolidationRejectionReason({ existing, next: bloated }), /结果变多/);
});

test('空输入不炸', () => {
  assert.equal(consolidationRejectionReason({}), '');
  assert.equal(consolidationRejectionReason({ existing: [{ content: '' }], next: ['x'] }), '');
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
