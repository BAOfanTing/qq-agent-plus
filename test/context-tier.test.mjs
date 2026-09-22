// 响应档位闸门：档位/概率决定的"这批消息要不要回"。
//
// 这块没有测过，用户反馈过一次"概率调中等还是都回"、一次"档位调低之后 @ 它也不回"。
// 概率用注入的 roll 钉死，避免随机导致的假红/假绿；真实回复率另有端到端实测
// （40~100 批消息统计，见提交说明）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { resolveContextTier } = await import('../src/llm/prompt.js');

const BASE = { atCount: 300, keywordCount: 100, randomCount: 300, allCount: 300, keywords: ['救命'] };
const entry = (text, extra = {}) => ({ text, ...extra });

test('4 档：任何消息都响应', () => {
  const r = resolveContextTier({
    triggerEntries: [entry('随便说点什么')],
    cfg: { ...BASE, contextTier: 4, randomPercent: 0 }
  });
  assert.equal(r.shouldRespond, true);
  assert.equal(r.reason, '全部响应');
  assert.equal(r.count, 300);
});

test('3 档：按概率决定，边界由注入的 roll 钉死', () => {
  const cfg = { ...BASE, contextTier: 3, randomPercent: 24.3 };
  const at = (roll) => resolveContextTier({ triggerEntries: [entry('普通消息')], cfg, roll });
  assert.equal(at(0).shouldRespond, true, 'roll 在概率内 → 回');
  assert.equal(at(24).shouldRespond, true);
  assert.equal(at(25).shouldRespond, false, 'roll 超出概率 → 不回');
  assert.equal(at(99).shouldRespond, false);
  assert.equal(at(99).reason, '未触发');
  assert.equal(at(99).count, 0);
});

test('1/2 档没有随机这条路：概率再高也不靠掷骰子回', () => {
  for (const contextTier of [1, 2]) {
    const r = resolveContextTier({
      triggerEntries: [entry('普通消息')],
      cfg: { ...BASE, contextTier, randomPercent: 100 },
      roll: 0
    });
    assert.equal(r.shouldRespond, false, `${contextTier} 档不该被随机命中`);
  }
});

test('关键词从 2 档起生效，1 档只认艾特', () => {
  const kw = [entry('救命啊')];
  assert.equal(resolveContextTier({ triggerEntries: kw, cfg: { ...BASE, contextTier: 1 }, roll: 100 }).shouldRespond, false);
  assert.equal(resolveContextTier({ triggerEntries: kw, cfg: { ...BASE, contextTier: 2 }, roll: 100 }).reason, '关键词命中');
});

test('被 @ 的判定：文本认得出，也要认存档里的 mentionsSelf', () => {
  const cfg = { ...BASE, contextTier: 1, randomPercent: 0 };
  const names = { selfNickname: '登录昵称', botName: '小鲸鱼', selfId: '888' };
  // 文本路径：@ 后面是机器人的名字
  assert.equal(resolveContextTier({
    triggerEntries: [entry('@小鲸鱼 在吗')], ...names, cfg, roll: 100
  }).reason, '被艾特');
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
