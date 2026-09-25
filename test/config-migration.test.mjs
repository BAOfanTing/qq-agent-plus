// 老配置（四段式滑条）读盘时必须一次性迁移成"滑条上的数字就是概率"。
//
// 这条用例专门防一个真踩过的坑（2026-09-22 审查发现）：把 `sliderMode: 'probability'`
// 写进 DEFAULT_CONFIG 之后，`loadConfig` 的 deepMerge 会替老配置补上这个键，
// 于是"文件里到底有没有这个键"再也分不出来 —— 迁移判定放进 updateConfig 时永远不成立，
// 老 1/2 档用户会被当成 5~20% 概率开始接话、老 4 档会丢掉"全响应"。
// 所以必须**真的写一份老形状的 config.json、再用新进程加载它**：
// 内存里构造对象（显式 sliderMode: ''）和同进程 import 都测不出这个坑
// （ESM 模块缓存会让 config-legacy 停留在第一次的 DATA_DIR 上）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 一个进程只挂一个 exit 处理器（每个用例各挂一个会触发 MaxListenersExceededWarning）
const tempDirs = new Set();
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});
const CONFIG_URL = pathToFileURL(path.join(REPO, 'src', 'core', 'config.js')).href;

/** 写一份 config.json → 新起一个 Node 进程加载它 → 取回 store（可选再跑一段脚本并取回第二次）。 */
function loadStoreInNewProcess(config, extraScript = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-migrate-'));
  tempDirs.add(dir);   // 用例自己造的临时目录自己清（约定见 test/README.md）
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const script = `
    process.env.QQ_AGENT_DATA_DIR = ${JSON.stringify(dir)};
    const { getConfig, updateConfig } = await import(${JSON.stringify(CONFIG_URL)});
    const first = structuredClone(getConfig().store);
    ${extraScript}
    console.log(JSON.stringify({ first, after: getConfig().store, file: ${JSON.stringify(file)} }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const parsed = JSON.parse(out.trim().split('\n').pop());
  return { ...parsed, dir };
}

test('老四段式滑条：1/2 档迁移成 0%，3 档保留概率，4 档迁移成 100%', () => {
  for (const [contextSliderPos, contextTier, randomPercent, wantPct, wantTier] of [
    [5, 1, 0, 0, 1],       // 老 1 档（仅艾特）：不掷骰子
    [15, 2, 0, 0, 1],      // 老 2 档（+关键词）：不掷骰子
    [55, 3, 50, 50, 3],    // 老 3 档正中：概率原样搬过来
    [95, 4, 100, 100, 4]   // 老 4 档（全响应）
  ]) {
    const { first } = loadStoreInNewProcess({ store: { contextSliderPos, contextTier, randomPercent } });
    assert.equal(first.randomPercent, wantPct, `位置 ${contextSliderPos} 应迁移成 ${wantPct}%`);
    assert.equal(first.contextSliderPos, wantPct, '滑条位置也落在概率上');
    assert.equal(first.contextTier, wantTier, `档位展示应为 ${wantTier}`);
    assert.equal(first.sliderMode, 'probability', '迁移后要打标记，避免二次换算');
  }
});

test('老配置连滑条位置都没有：按老档位换算，不能被当成"没填=全响应"', () => {
  assert.equal(
    loadStoreInNewProcess({ store: { contextTier: 1, randomPercent: 0 } }).first.randomPercent,
    0, '老 1 档 → 0%'
  );
  assert.equal(
    loadStoreInNewProcess({ store: { contextTier: 4, randomPercent: 100 } }).first.randomPercent,
    100, '老 4 档 → 100%'
  );
  assert.equal(
    loadStoreInNewProcess({ store: { contextSliderPos: null, contextTier: 2, randomPercent: 0 } }).first.randomPercent,
    0, 'null 位置 → 按老 2 档 → 0%'
  );
});

test('分群表也换算；新语义原样保留；写回后再加载不漂移', () => {
  const legacy = loadStoreInNewProcess({
    store: {
      contextTier: 4, randomPercent: 100, contextSliderPos: 95,
      unifiedTier: false, groupSliderPos: { '111': 5, '222': 55, '333': 95 }
    }
  }, 'updateConfig({ ui: { refreshMs: 7000 } });');   // 迁移后保存一次（走真实落盘路径）
  assert.deepEqual(
    legacy.first.groupSliderPos,
    { '111': 0, '222': 50, '333': 100 },
    '老的分群位置要换算成概率'
  );
  assert.equal(legacy.after.randomPercent, 100, '保存一次之后仍是 100%');

  // 幂等：写回文件后再加载一次，值不漂移（43 不能再被换算成 32.9）
  const reloaded = loadStoreInNewProcess(JSON.parse(fs.readFileSync(legacy.file, 'utf8')));
  assert.equal(reloaded.first.randomPercent, 100);
  assert.deepEqual(reloaded.first.groupSliderPos, { '111': 0, '222': 50, '333': 100 });

  // 已经是新语义的配置原样保留
  const fresh = loadStoreInNewProcess({
    store: { sliderMode: 'probability', contextSliderPos: 43, contextTier: 3, randomPercent: 43 }
  });
  assert.equal(fresh.first.randomPercent, 43);
});

test('只有 randomPercent、没有 tier/位置的老配置：按概率本身读，别变成全响应', () => {
  // 手写配置可能长这样。迁移时若按"没有 tier → 默认 4 档"处理，0% 会被抬成 100%（全响应）
  const onlyPct = loadStoreInNewProcess({ store: { randomPercent: 0, atCount: 5 } });
  assert.equal(onlyPct.first.randomPercent, 0, '0% 要原样保留');
  assert.equal(onlyPct.first.contextTier, 1);
  const halfPct = loadStoreInNewProcess({ store: { randomPercent: 50 } });
  assert.equal(halfPct.first.randomPercent, 50);
  assert.equal(halfPct.first.contextTier, 3);

  // 完全没有 store 段的老配置：沿用默认（全响应），不报错
  const bare = loadStoreInNewProcess({ server: { port: 3210, token: 'x' } });
  assert.equal(bare.first.randomPercent, 100, '默认是全响应（与老默认档 4 一致）');
  assert.equal(bare.first.sliderMode, 'probability');
});

/** 同 loadStoreInNewProcess，但回传整个配置（顶层），用于验证"坏字段不连累其他配置"。 */
function loadWholeConfigInNewProcess(rawText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-malformed-'));
  tempDirs.add(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, rawText);
  const script = `
    process.env.QQ_AGENT_DATA_DIR = ${JSON.stringify(dir)};
    const { getConfig } = await import(${JSON.stringify(CONFIG_URL)});
    console.log(JSON.stringify(structuredClone(getConfig())));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return { config: JSON.parse(out.trim().split('\n').pop()), dir };
}

// ── 2026-09-23 全面审查发现：坏字段会连累整份配置（apiKey/白名单/人设一起没） ──

test('子段被手改成标量：其余配置不许被整份退回默认值', () => {
  // identityPilot.friendProposal 被手改成 true 时，老代码在迁移里抛 TypeError
  // （Cannot create property 'mode' on boolean），被 loadConfig 的 catch 吞掉 →
  // 整份配置退回默认值并持久化 → apiKey、白名单、人设正文全丢。
  const { config } = loadWholeConfigInNewProcess(JSON.stringify({
    api: { apiKey: 'keep-me', model: 'm1', baseUrl: 'https://example.invalid/v1' },
    identityPilot: { friendProposal: true },
    aiNames: { self: '小鲸鱼' }
  }));
  assert.equal(config.api.apiKey, 'keep-me', '一个坏子段不能把整份配置冲掉');
  assert.equal(config.api.model, 'm1');
  assert.equal(config.identityPilot.friendProposal.mode, 'triggered', '坏掉的子段按默认模式恢复');
});

test('config.json 解析不了：退回默认值，但先把原件留一份', () => {
  const { config, dir } = loadWholeConfigInNewProcess('{"api": {"apiKey": "keep-me"},');
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith('config.json.broken-'));
  assert.equal(backups.length, 1, '解析失败必须留下 config.json.broken-* 备份');
  assert.match(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), /keep-me/);
  assert.equal(String(config.api.apiKey || ''), '', '退回默认值（apiKey 为空）');
});

test('整个 config.json 是个标量：按空配置恢复，不抛错', () => {
  const { config } = loadWholeConfigInNewProcess('5');
  assert.equal(typeof config, 'object');
  // 按"未绑定"恢复（与 persona 段被写坏时的规则一致）：坏字段不许被治好成绑定默认卡
  assert.equal(config.persona.templateId, '', '按未绑定恢复，不静默绑上默认卡');
});

test('省 Token：老配置缺键补 off、坏值不许带崩整份配置', () => {
  const missing = loadWholeConfigInNewProcess(JSON.stringify({ api: { apiKey: 'keep-me' } }));
  assert.equal(missing.config.tokenSaver?.mode, 'off', '缺键时补 off（默认关闭）');
  const bad = loadWholeConfigInNewProcess(JSON.stringify({ tokenSaver: { mode: 5 }, api: { apiKey: 'keep-me' } }));
  assert.equal(bad.config.tokenSaver.mode, 'off', '坏值按 off');
  assert.equal(bad.config.api.apiKey, 'keep-me', '坏值不许把整份配置冲掉');
  const scaled = loadWholeConfigInNewProcess(JSON.stringify({ tokenSaver: 'balanced', api: { apiKey: 'keep-me' } }));
  assert.equal(scaled.config.tokenSaver.mode, 'off', '整段被写成字符串时也按 off');
  const good = loadWholeConfigInNewProcess(JSON.stringify({ tokenSaver: { mode: 'aggressive' } }));
  assert.equal(good.config.tokenSaver.mode, 'aggressive', '合法值原样保留');
});
