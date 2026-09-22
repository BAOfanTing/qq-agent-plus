// 响应概率闸门：决定"这批消息要不要回"。
//
// 语义（2026-09-22 起）：**滑条上的数字就是概率**（0~100%）——
//   0%   只回 @ 和关键词（关键词表为空时就只回 @）
//   中间 普通消息按该概率回；被 @ 或命中关键词仍一定回
//   100% 任何消息都回（全响应）
// 概率用注入的 roll 钉死，避免随机导致的假红/假绿；真实回复率另有端到端实测
// （每档位独立进程、40~100 批消息统计模型调用次数）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { resolveContextTier } = await import('../src/llm/prompt.js');

const BASE = { atCount: 300, keywordCount: 100, randomCount: 60, allCount: 300, keywords: ['救命'] };
const entry = (text, extra = {}) => ({ text, ...extra });

test('100% = 全响应：任何消息都回', () => {
  const r = resolveContextTier({
    triggerEntries: [entry('随便说点什么')],
    cfg: { ...BASE, randomPercent: 100 },
    roll: 99
  });
  assert.equal(r.shouldRespond, true);
  assert.equal(r.reason, '全部响应');
  assert.equal(r.count, 300);
});

test('0% = 只回 @ 和关键词', () => {
  const plain = resolveContextTier({
    triggerEntries: [entry('随便说点什么')], cfg: { ...BASE, randomPercent: 0 }, roll: 0
  });
  assert.equal(plain.shouldRespond, false, '0% 时普通消息不回');
  assert.equal(plain.reason, '未触发');
  assert.equal(plain.count, 0);

  // 关键词表清空后，0% 就只剩 @ 能唤醒
  const noKeyword = { ...BASE, randomPercent: 0, keywords: [] };
  assert.equal(resolveContextTier({ triggerEntries: [entry('救命啊')], cfg: noKeyword, roll: 0 }).shouldRespond, false);
});

test('中间概率：掷骰子决定，边界由注入的 roll 钉死', () => {
  const cfg = { ...BASE, randomPercent: 24.3 };
  const at = (roll) => resolveContextTier({ triggerEntries: [entry('普通消息')], cfg, roll });
  assert.equal(at(0).shouldRespond, true, 'roll 在概率内 → 回');
  assert.equal(at(24).shouldRespond, true);
  assert.equal(at(25).shouldRespond, false, 'roll 超出概率 → 不回');
  assert.equal(at(99).shouldRespond, false);
  // 概率原样出现在 reason 里，方便排查"我设了多少"
  assert.match(at(0).reason, /24\.3%/);
});

test('被 @ 或命中关键词一定回，不受概率影响', () => {
  const cfg = { ...BASE, randomPercent: 0 };
  const names = { selfNickname: '登录昵称', botName: '小鲸鱼', selfId: '888' };
  const at = resolveContextTier({ triggerEntries: [entry('@小鲸鱼 在吗')], ...names, cfg, roll: 100 });
  assert.equal(at.shouldRespond, true);
  assert.equal(at.reason, '被艾特');
  const kw = resolveContextTier({ triggerEntries: [entry('救命啊')], cfg, roll: 100 });
  assert.equal(kw.shouldRespond, true);
  assert.equal(kw.reason, '关键词命中');
});

test('@ 的判定：文本认得出，也认存档里的 mentionsSelf', () => {
  const cfg = { ...BASE, randomPercent: 0 };
  const names = { selfNickname: '登录昵称', botName: '小鲸鱼', selfId: '888' };
  // 群里把名片改过：文本里是群名片，跟名字/昵称都对不上 —— 靠入库时算的 mentionsSelf 也要认
  const byFlag = resolveContextTier({
    triggerEntries: [entry('@群名片甲 在吗', { mentionsSelf: true })], ...names, cfg, roll: 100
  });
  assert.equal(byFlag.shouldRespond, true, '群名片与昵称不一致时不能漏判');
  assert.equal(byFlag.reason, '被艾特');
  // 只是文本里出现名字（没 @）不算
  assert.equal(resolveContextTier({
    triggerEntries: [entry('小鲸鱼今天怎么样')], ...names, cfg, roll: 100
  }).shouldRespond, false);
});

test('读多少条已读：由触发原因决定，各条数互相独立', () => {
  const names = { selfNickname: '小鲸鱼', botName: '小鲸鱼', selfId: '888' };
  const cfg = { ...BASE, randomPercent: 50, atCount: 5, keywordCount: 10, randomCount: 20, allCount: 50 };
  assert.equal(resolveContextTier({ triggerEntries: [entry('@小鲸鱼 在吗')], ...names, cfg, roll: 60 }).count, 5);
  assert.equal(resolveContextTier({ triggerEntries: [entry('救命啊')], cfg, roll: 60 }).count, 10);
  assert.equal(resolveContextTier({ triggerEntries: [entry('普通消息')], cfg, roll: 10 }).count, 20);
  assert.equal(resolveContextTier({ triggerEntries: [entry('普通消息')], cfg: { ...cfg, randomPercent: 100 }, roll: 99 }).count, 50);
});

test('概率没填时按全响应处理（老配置里这字段可能是 0 或缺失）', () => {
  const missing = resolveContextTier({ triggerEntries: [entry('普通消息')], cfg: { ...BASE, randomPercent: undefined }, roll: 99 });
  assert.equal(missing.shouldRespond, true, '缺字段 → 回落到全响应，跟老默认一致');
  const zero = resolveContextTier({ triggerEntries: [entry('普通消息')], cfg: { ...BASE, randomPercent: 0 }, roll: 0 });
  assert.equal(zero.shouldRespond, false, '0 是合法值：不能被当成"没填"');
});
