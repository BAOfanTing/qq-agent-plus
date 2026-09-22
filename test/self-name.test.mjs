// 「机器人叫什么」只有一个口径：群友/好友实际看到的名字优先。
//
// 背景（2026-09-23 提问）：QQ 昵称、群内展示名、机器人名字三者在控制台里是三个字段，
// 各处提示词原本各挑各的来源 —— 群里显示「犊子」、说说里却自称「小鲸鱼」。
// 统一走 resolveSelfName：群内展示名 → 账号昵称 → 机器人名字。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { resolveSelfName } = await import('../src/core/util.js');
const { buildMomentSystemPrompt, momentPersonaHash } = await import('../src/llm/moment-prompt.js');
const { buildQzoneInteractionPrompt, qzoneInteractionPersonaHash } = await import('../src/llm/qzone-interaction-prompt.js');
const { buildFriendReviewSystemPrompt } = await import('../src/llm/friend-review-prompt.js');

const PERSONA = { botName: '小鲸鱼', selfNickname: '', roleText: '# 角色卡：猫娘（二次元）\n你是只猫。', customRules: '' };

test('名字优先级：群内展示名 > 账号昵称 > 机器人名字', () => {
  assert.equal(resolveSelfName({ selfNickname: '小明', botName: '小鲸鱼' }, '犊子'), '小明');
  assert.equal(resolveSelfName({ selfNickname: '', botName: '小鲸鱼' }, '犊子'), '犊子');
  assert.equal(resolveSelfName({ selfNickname: '', botName: '小鲸鱼' }, ''), '小鲸鱼');
  assert.equal(resolveSelfName({}, ''), '我');
  assert.equal(resolveSelfName({ selfNickname: '   ' }, '犊子'), '犊子', '空白值当没填');
});

test('说说 / 空间互动 / 好友评估也认账号昵称，不再自称机器人名字', () => {
  const moment = buildMomentSystemPrompt(PERSONA, { accountNickname: '犊子' });
  assert.ok(moment.includes('以「犊子」的身份'), `说说提示词该用群友看到的名字：${moment.slice(0, 60)}`);
  assert.ok(!moment.includes('「小鲸鱼」'), '不该再出现机器人名字顶替群名片');

  const qzone = buildQzoneInteractionPrompt(PERSONA, { accountNickname: '犊子' });
  assert.ok(qzone.includes('以「犊子」的身份'));

  const review = buildFriendReviewSystemPrompt(PERSONA, { accountNickname: '犊子' });
  assert.ok(review.includes('你是「犊子」'));

  // 没传账号昵称时退回机器人名字（旧行为，保证兼容）
  assert.ok(buildMomentSystemPrompt(PERSONA).includes('以「小鲸鱼」的身份'));
  assert.ok(buildFriendReviewSystemPrompt(PERSONA).includes('你是「小鲸鱼」'));
});

test('改名会改变人设哈希，说说/互动会重新生成', () => {
  const a = momentPersonaHash(PERSONA, '犊子');
  const b = momentPersonaHash(PERSONA, '小鲸鱼');
  assert.notEqual(a, b, '显示名变了，哈希要跟着变，否则旧内容会被当成"人设没变"复用');
  assert.equal(a, momentPersonaHash(PERSONA, '犊子'), '同一个名字要稳定');
  assert.notEqual(qzoneInteractionPersonaHash(PERSONA, '犊子'), qzoneInteractionPersonaHash(PERSONA, '小鲸鱼'));
});
