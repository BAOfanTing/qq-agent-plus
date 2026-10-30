import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesBlacklistKeyword, validateBlacklistKeywordRules } from '../src/core/keyword-rules.js';

test('blacklist rules support literal and opt-in regex matching', () => {
  assert.equal(matchesBlacklistKeyword('这是 SPAM 广告', ['spam']), true);
  assert.equal(matchesBlacklistKeyword('转发限时抽奖', ['re:^转发.*抽奖$']), true);
  assert.equal(matchesBlacklistKeyword('普通聊天', ['re:^转发.*抽奖$']), false);
});

test('unsafe blacklist regexes are rejected', () => {
  assert.match(validateBlacklistKeywordRules(['re:(']), /无效/);
  assert.match(validateBlacklistKeywordRules(['re:(a+)+']), /不能重复/);
  assert.match(validateBlacklistKeywordRules(['re:(?=广告)广告']), /不支持/);
});
