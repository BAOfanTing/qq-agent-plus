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
  // +1 条，但多出一大段（超过 80 字的容忍度）也算编造
  const bloated = [...existing.map((e) => e.content), '这条凭空多出来的印象'.repeat(12)];
  assert.match(consolidationRejectionReason({ existing, next: bloated }), /结果变多/);
});

test('短印象的拆分容忍度是 80 字：增量落在 41~80 放行、超过 80 拒绝', () => {
  // prevChars = 100（单条），拆成两条合计 170 → grew = 70：
  // 旧阈值（40）会拒、新阈值（80）放行 —— 这条才真正卡住这次的改动
  const hundred = [{ content: 'x'.repeat(100) }];
  assert.equal(consolidationRejectionReason({ existing: hundred, next: ['y'.repeat(85), 'z'.repeat(85)] }), '');
  // 同一起点，增量 81 字（合计 181）→ 必须拒绝，钉住上边界
  assert.match(consolidationRejectionReason({ existing: hundred, next: ['y'.repeat(90), 'z'.repeat(91)] }), /结果变多/);
  // 极短记忆（prevChars=9）的绝对增量上限同样是 80：塞 80 字就超
  const short = [{ content: '爱问人设，也爱逗你' }];
  assert.equal(consolidationRejectionReason({ existing: short, next: ['爱问你"现在什么人设"，反复问', '爱逗人表演，会要你喵一声'] }), '');
  assert.match(consolidationRejectionReason({ existing: short, next: ['爱问人设，也爱逗你', '这条完全是新编的'.repeat(15)] }), /结果变多/);
});

test('条数没变多、但字数翻倍地涨 → 也拒绝（往里塞新内容）', () => {
  const padded = existing.map((e) => `${e.content}${'补充的新内容'.repeat(10)}`);
  assert.match(consolidationRejectionReason({ existing, next: padded }), /字数暴涨/);
  // 正常改写（稍微写详细一点）仍然采纳
  const slightlyLonger = existing.map((e) => `${e.content}（细节补全）`);
  assert.equal(consolidationRejectionReason({ existing, next: slightlyLonger }), '');
});

test('坏结构：结果不是数组、或条目不是字符串 → 拒绝（不能当"无可保留"把印象清空）', () => {
  assert.match(consolidationRejectionReason({ existing, next: { result: ['a'] } }), /不是 impressions 数组/);
  assert.match(consolidationRejectionReason({ existing, next: ['正常一条', { content: '长文本被我包成了对象' }] }), /非字符串条目/);
  assert.match(consolidationRejectionReason({ existing, next: [42] }), /非字符串条目/);
  // 明确"没有可保留的"仍然是合法的空数组
  assert.equal(consolidationRejectionReason({ existing, next: [] }), '');
});

test('空输入不炸', () => {
  assert.equal(consolidationRejectionReason({}), '');
  assert.equal(consolidationRejectionReason({ existing: [{ content: '' }], next: ['x'] }), '');
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
