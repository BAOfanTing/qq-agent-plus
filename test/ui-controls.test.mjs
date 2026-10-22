// 新增控制台开关的接线守卫：控件 id、渲染端、保存端必须同时存在。
// 这类缺口只有真机点保存才看得见（界面显示"已保存"、配置却没变），用静态断言兜住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(repo, ...p), 'utf8');
const chat = read('ui/pages/chat.js');
const save = read('ui/pages/settings-save.js');
const settings = read('ui/pages/settings.js');
const voice = read('ui/pages/settings-voice.js');
const moments = read('ui/pages/moments.js');
const platform = read('ui/pages/platform.js');
const format = read('ui/core/format.js');

test('聊天设置：回复纠正 / 拍一拍 / 自主节奏 / 数据保留控件与保存接线', () => {
  for (const id of ['cfg-reply-guard', 'cfg-poke-reply', 'cfg-pacing-enabled',
    'cfg-pacing-default', 'cfg-pacing-min', 'cfg-pacing-max', 'cfg-pacing-instant',
    'cfg-store-maxmessages', 'cfg-store-keepsessions', 'cfg-store-ioprofile',
    'cfg-store-iocustom', 'cfg-store-persistms', 'cfg-store-sqlitesync',
    'cfg-proactive', 'cfg-pro-group', 'cfg-pro-private', 'cfg-pro-followup', 'cfg-pro-selfwake']) {
    assert.ok(chat.includes(`id="${id}"`), `缺少控件 ${id}`);
  }
  assert.match(save, /groupEnabled: chk\('#cfg-pro-group'/,
    '群聊范围开关必须接到保存端，否则界面上勾了也不生效');
  assert.match(save, /privateEnabled: chk\('#cfg-pro-private'/,
    '私聊范围开关必须接到保存端，否则界面上勾了也不生效');
  // 默认勾选状态与保存端 fallback 必须同口径：群聊默认开、私聊默认关
  assert.match(chat, /id="cfg-pro-group"[^\n]*groupEnabled !== false/);
  assert.match(chat, /id="cfg-pro-private"[^\n]*privateEnabled === true/);
  for (const key of ['replyGuardEnabled', 'pokeReplyEnabled']) {
    assert.ok(save.includes(`${key}:`), `保存端缺少 ${key}`);
  }
  assert.match(save, /patch\.pacing = \{/);
  assert.match(save, /maxMessagesPerChat: clampInt/);
  assert.match(save, /keepSessionFiles: numKeep/);
  // 只给三个预设档位，不把毫秒数与 SQLite 同步级别直接丢给用户
  assert.match(save, /IO_PROFILES\[val\('#cfg-store-ioprofile'/);
  for (const [key, ms, sync] of [['balanced', 10000, 'FULL'], ['low', 30000, 'NORMAL'], ['minimal', 60000, 'NORMAL']]) {
    assert.match(format, new RegExp(`${key}: \\{ persistMs: ${ms}, synchronous: '${sync}' \\}`), `${key} 档位映射`);
  }
});

test('记忆 / 预算 / 图片生成 / 群游戏：新开关都接到保存端', () => {
  assert.ok(settings.includes('id="cfg-mem-handoff"'));
  assert.ok(save.includes('handoffEnabled: chk('));
  assert.ok(settings.includes('id="cfg-budget-notify"'));
  assert.ok(save.includes('notify: chk('));
  assert.ok(voice.includes('id="cfg-img-autosend"'));
  assert.ok(save.includes('autoSend: chk('));
  assert.ok(moments.includes('id="cfg-game-maxtime"'));
  assert.ok(save.includes('maxDurationMin: numKeep'));
});

test('平台能力：插件宿主高级项有控件、保存时只提交这几个键', () => {
  for (const id of ['cfg-plugin-memory', 'cfg-plugin-calls', 'cfg-plugin-netiso', 'cfg-plugin-requirenetiso']) {
    assert.ok(platform.includes(`id="${id}"`), `缺少控件 ${id}`);
  }
  assert.match(save, /patch\.plugins = \{/);
  assert.match(save, /limits: \{/);
  assert.match(save, /networkIsolation: chk\(/);
  assert.match(save, /requireNetworkIsolation: chk\(/);
});
