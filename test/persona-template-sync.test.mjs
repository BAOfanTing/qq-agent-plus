// 内置角色卡的"文件即来源"约定：
//   控制台选卡时会把模板 id 存进 persona.templateId；只要还绑着内置卡，
//   载入配置 / 保存配置时就按 roles/*.md 的正文刷新实例副本。
//
// 背景：实例里存的是正文副本，以前改了卡必须回控制台重选一次才生效
// （"改完卡没生效"被反复当成 bug 报上来）。这里同时盯住反面：手改正文、
// 用自定义卡、以及**老配置没有 templateId 键**时，正文绝不能被文件覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-sync-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.DEBUG_SERVER_URL = 'http://127.0.0.1:1/event';

const { PERSONAS, applyPersonaTemplate, builtinPersonaTemplate, PERSONA_TEMPLATE_IDS } =
  await import('../src/personas.js');
const { loadConfig, updateConfig, CONFIG_FILE } = await import('../src/core/config.js');

const writeConfig = (persona) => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ persona }, null, 2), { mode: 0o600 });
};
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

test('登记的模板 id 都能取到卡，未知 id 返回 null', () => {
  assert.ok(PERSONA_TEMPLATE_IDS.includes('maoniang'));
  assert.equal(builtinPersonaTemplate('maoniang').name, '猫娘（二次元）');
  assert.equal(builtinPersonaTemplate('custom_0'), null);
  assert.equal(builtinPersonaTemplate(''), null);
  assert.equal(builtinPersonaTemplate(undefined), null);
});

test('绑定的内置卡：载入时按卡文件刷新正文（改了卡不用重选）', () => {
  writeConfig({ templateId: 'maoniang', roleText: '# 角色卡：猫娘（二次元）\n（实例里的旧正文）', behaviorProfile: 'legacy' });
  const cfg = loadConfig();
  assert.equal(cfg.persona.roleText, PERSONAS.maoniang.text, '正文应被卡文件刷新');
  assert.equal(cfg.persona.behaviorProfile, PERSONAS.maoniang.behaviorProfile);
});

test('卡文件改了以后，下次载入就跟着变（模拟升级带的正文更新）', () => {
  const original = PERSONAS.maoniang.text;
  try {
    PERSONAS.maoniang.text = '# 角色卡：猫娘（二次元）\n（升级后的新正文）';
    writeConfig({ templateId: 'maoniang', roleText: original, behaviorProfile: 'legacy' });
    assert.equal(loadConfig().persona.roleText, PERSONAS.maoniang.text);
  } finally {
    PERSONAS.maoniang.text = original;
  }
  // 换回旧正文后，绑定关系还在：下次载入又把正文刷回文件内容
  assert.equal(loadConfig().persona.roleText, PERSONAS.maoniang.text);
});

test('未绑定（手改正文 / 自定义卡）：正文原样保留', () => {
  writeConfig({ templateId: '', roleText: '我手改的正文', behaviorProfile: 'grounded' });
  let cfg = loadConfig();
  assert.equal(cfg.persona.roleText, '我手改的正文');
  assert.equal(cfg.persona.behaviorProfile, 'grounded', '未绑定时档位也不该被改');

  writeConfig({ templateId: 'custom_0', roleText: '自定义卡正文', behaviorProfile: 'legacy' });
  cfg = loadConfig();
  assert.equal(cfg.persona.roleText, '自定义卡正文');
});

test('老配置（没有 templateId 键）不会被误绑成默认卡', () => {
  // 默认值里带的是 templateId: 'xiaojingyu'，迁移必须补空串把它挡住
  writeConfig({ roleText: '# 角色卡：猫娘（二次元）\n（老实例里存着的猫娘正文）' });
  const cfg = loadConfig();
  assert.equal(cfg.persona.templateId, '');
  assert.ok(cfg.persona.roleText.includes('猫娘'), '老实例的正文不能被换成默认卡');
  assert.notEqual(cfg.persona.roleText, PERSONAS.xiaojingyu.text);
});

test('保存配置时同样会刷新，且只在绑定时生效', () => {
  writeConfig({ templateId: 'maoniang', roleText: '旧正文', behaviorProfile: 'legacy' });
  updateConfig({ persona: { templateId: 'maoniang', roleText: '旧正文' } });
  assert.equal(updateConfig({}).persona.roleText, PERSONAS.maoniang.text);

  // 解绑后保存自己的正文：不会被文件覆盖，且落盘
  updateConfig({ persona: { templateId: '', roleText: '解绑后的自定义正文' } });
  assert.equal(readConfig().persona.roleText, '解绑后的自定义正文');
  assert.equal(readConfig().persona.templateId, '');
});

test('applyPersonaTemplate 对空配置/坏配置不抛错', () => {
  assert.equal(applyPersonaTemplate(null), null);
  assert.equal(applyPersonaTemplate({}), null);
  assert.equal(applyPersonaTemplate({ persona: {} }), null);
  assert.equal(applyPersonaTemplate({ persona: { templateId: 'maoniang', roleText: PERSONAS.maoniang.text } }), null);
  const note = applyPersonaTemplate({ persona: { templateId: 'maoniang', roleText: 'stale' } });
  assert.deepEqual(note, { id: 'maoniang', name: '猫娘（二次元）' });
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
