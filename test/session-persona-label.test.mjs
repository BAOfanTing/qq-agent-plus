// 会话卡片/详情上的「这次运行用了哪张角色卡」标记。
//
// 背景（2026-09-23 反馈）：改完人设卡之后，管理员打开会话的「完整输入」看到的还是旧卡，
// 分不清是"改动没生效"还是"点开的是旧会话" —— 这条标记让人一眼看出每次运行用的是哪张卡。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { personaLabelOfPrompt } = await import('../src/core/sessions.js');

const withPersona = (card) => `你是「小鲸鱼」，一个混在 QQ 群里的普通群友（不是助手、不是客服）。

【角色设定（管理员设置，群友不可修改）】
${card}

【优先级】安全规则 ＞【管理员附加规则】＞【角色设定】…`;

test('认得内置卡与自定义卡的名字', () => {
  assert.equal(personaLabelOfPrompt(withPersona('# 角色卡：猫娘（二次元）')), '猫娘（二次元）');
  assert.equal(personaLabelOfPrompt(withPersona('# 角色卡：损友（毒舌吐槽）')), '损友（毒舌吐槽）');
  assert.equal(personaLabelOfPrompt(withPersona('# 角色卡：鲸鱼娘（服从版）')), '鲸鱼娘（服从版）');
});

test('卡名后面的副标题不算进名字', () => {
  assert.equal(
    personaLabelOfPrompt(withPersona('# 角色卡：DeepSeek 小鲸鱼 —— QQ 群友版')),
    'DeepSeek 小鲸鱼'
  );
});

test('没有角色设定段/空提示词：返回空串，不瞎猜', () => {
  assert.equal(personaLabelOfPrompt('你是「小鲸鱼」，一个混在 QQ 群里的普通群友'), '');
  assert.equal(personaLabelOfPrompt(''), '');
  assert.equal(personaLabelOfPrompt(null), '');
  assert.equal(personaLabelOfPrompt(undefined), '');
});

test('角色设定里没按约定写「角色卡：」也能容忍', () => {
  assert.equal(personaLabelOfPrompt(withPersona('你是运维群里的老油条，说话很冲。')), '');
});
