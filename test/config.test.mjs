import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-stable-'));
process.env.QQ_AGENT_DATA_DIR = dir;

fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  identityPilot: {
    enabled: false,
    graduated: false,
    incomingFriendRequest: {
      enabled: false,
      autoWhitelist: false,
      maxPending: 25
    },
    friendProposal: {
      enabled: false,
      graduated: false,
      activeDispatchEnabled: false,
      ownerUin: '12345678',
      mode: 'prompt',
      cooldownDays: 45,
      maxPending: 7
    }
  },
  slangPilot: {
    enabled: true,
    graduated: true,
    ownerUin: '45678901',
    minOccurrences: 2,
    webResearch: true,
    maxResearchRounds: 5
  },
  incidentPilot: {
    enabled: false,
    graduated: false,
    ownerUin: '87654321',
    retentionDays: 123
  },
  autoUpdate: {
    enabled: false,
    ownerUin: '56789012'
  },
  allow: { groups: [], private: [] },
  deny: { groups: [], private: ['12345678'] },
  ui: { refreshMs: 15000 }
}, null, 2));

const {
  DEFAULT_CONFIG,
  adminOwnerUin,
  friendProposalEnabled,
  friendRequestDispatchEnabled,
  getConfig,
  identityPilotEnabled,
  incomingFriendRequestEnabled,
  incidentPilotEnabled,
  promptFriendProposalEnabled,
  slangPilotEnabled,
  triggeredFriendProposalEnabled,
  updateConfig
} = await import('../src/core/config.js');

test('promoted capabilities share one admin and retired slang config is purged', async (t) => {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(DEFAULT_CONFIG.identityPilot.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.friendProposal.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(DEFAULT_CONFIG.incidentPilot.enabled, true);
  assert.deepEqual(DEFAULT_CONFIG.slangPilot, { enabled: false, graduated: false });
  assert.equal(DEFAULT_CONFIG.admin.ownerUin, '');

  // Old installs had separate owner fields. Identity/Friends is the migration
  // priority. Current administrator consumers keep compatibility mirrors, while
  // retired slang research loses all owner/tuning configuration entirely.
  const cfg = getConfig();
  assert.equal(adminOwnerUin(cfg), '12345678');
  assert.equal(cfg.admin.ownerUin, '12345678');
  assert.equal(cfg.identityPilot.friendProposal.ownerUin, '12345678');
  assert.equal(cfg.incidentPilot.ownerUin, '12345678');
  assert.equal(cfg.autoUpdate.ownerUin, '12345678');
  assert.deepEqual(cfg.slangPilot, { enabled: false, graduated: false });
  assert.ok(cfg.allow.private.includes('12345678'));
  assert.ok(!cfg.deny.private.includes('12345678'));

  assert.equal(cfg.identityPilot.enabled, true);
  assert.equal(cfg.identityPilot.graduated, true);
  assert.equal(cfg.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(cfg.identityPilot.friendProposal.enabled, true);
  assert.equal(cfg.identityPilot.friendProposal.graduated, true);
  assert.equal(cfg.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(cfg.identityPilot.incomingFriendRequest.autoWhitelist, false);
  assert.equal(cfg.identityPilot.incomingFriendRequest.maxPending, 25);
  assert.equal(cfg.identityPilot.friendProposal.mode, 'prompt');
  assert.equal(cfg.identityPilot.friendProposal.cooldownDays, 45);
  assert.equal(cfg.identityPilot.friendProposal.maxPending, 7);
  assert.equal(cfg.incidentPilot.enabled, true);
  assert.equal(cfg.incidentPilot.graduated, true);
  assert.equal(cfg.incidentPilot.retentionDays, 123);

  assert.equal(identityPilotEnabled({ identityPilot: { enabled: false } }), true);
  assert.equal(friendProposalEnabled({}), true);
  assert.equal(friendRequestDispatchEnabled({}), true);
  assert.equal(incomingFriendRequestEnabled({}), true);
  assert.equal(incidentPilotEnabled({ incidentPilot: { enabled: false } }), true);
  assert.equal(slangPilotEnabled({ slangPilot: { enabled: true } }), false);
  assert.equal(promptFriendProposalEnabled(cfg), true);
  assert.equal(triggeredFriendProposalEnabled(cfg), false);

  // Stale callers may still POST removed gates and old per-feature owners.
  // None can disable stable infrastructure, change the administrator
  // independently, or revive retired slang-research settings.
  const stale = updateConfig({
    identityPilot: {
      enabled: false,
      incomingFriendRequest: { enabled: false },
      friendProposal: {
        enabled: false,
        activeDispatchEnabled: false,
        ownerUin: '22222222'
      }
    },
    incidentPilot: { enabled: false, ownerUin: '33333333' },
    autoUpdate: { ownerUin: '44444444' },
    slangPilot: {
      enabled: true,
      graduated: true,
      ownerUin: '55555555',
      minOccurrences: 1,
      webResearch: true
    },
    ui: { refreshMs: 7000 }
  });

  assert.equal(stale.ui.refreshMs, 7000);
  assert.equal(stale.admin.ownerUin, '12345678');
  assert.equal(stale.identityPilot.friendProposal.ownerUin, '12345678');
  assert.equal(stale.incidentPilot.ownerUin, '12345678');
  assert.equal(stale.autoUpdate.ownerUin, '12345678');
  assert.deepEqual(stale.slangPilot, { enabled: false, graduated: false });
  assert.equal(stale.identityPilot.enabled, true);
  assert.equal(stale.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(stale.identityPilot.friendProposal.enabled, true);
  assert.equal(stale.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(stale.incidentPilot.enabled, true);

  // The global setting is the only supported write path. It fans out to the
  // remaining compatibility mirrors and guarantees private admin access.
  const next = updateConfig({ admin: { ownerUin: '23456789' } });
  assert.equal(adminOwnerUin(next), '23456789');
  assert.equal(next.identityPilot.friendProposal.ownerUin, '23456789');
  assert.equal(next.incidentPilot.ownerUin, '23456789');
  assert.equal(next.autoUpdate.ownerUin, '23456789');
  assert.deepEqual(next.slangPilot, { enabled: false, graduated: false });
  assert.ok(next.allow.private.includes('23456789'));
  assert.ok(!next.deny.private.includes('23456789'));

  assert.throws(
    () => updateConfig({ admin: { ownerUin: 'not-a-qq' } }),
    /管理员 QQ 必须为 5 到 15 位数字/
  );

  await new Promise((resolve) => setTimeout(resolve, 500));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.ui.refreshMs, 7000);
  assert.equal(saved.admin.ownerUin, '23456789');
  assert.equal(saved.identityPilot.friendProposal.ownerUin, '23456789');
  assert.equal(saved.incidentPilot.ownerUin, '23456789');
  assert.equal(saved.autoUpdate.ownerUin, '23456789');
  assert.equal(saved.identityPilot.enabled, true);
  assert.equal(saved.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(saved.identityPilot.friendProposal.enabled, true);
  assert.equal(saved.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(saved.incidentPilot.enabled, true);
  assert.deepEqual(saved.slangPilot, { enabled: false, graduated: false });
});

test('响应滑条：滑条值就是概率，老配置保存时一次性迁移过来', async () => {
  const { updateConfig } = await import('../src/core/config.js');

  // 新语义：传什么就是多少概率（0 是合法值，不能被当成"没填"回落成 100）
  const zero = updateConfig({ store: { contextSliderPos: 0, sliderMode: 'probability' } });
  assert.equal(zero.store.randomPercent, 0, '0% = 只回 @ 和关键词');
  assert.equal(zero.store.contextTier, 1, '0% 归 1 档展示');
  const mid = updateConfig({ store: { contextSliderPos: 43, sliderMode: 'probability' } });
  assert.equal(mid.store.randomPercent, 43);
  assert.equal(mid.store.contextTier, 3);
  const full = updateConfig({ store: { contextSliderPos: 100, sliderMode: 'probability' } });
  assert.equal(full.store.randomPercent, 100);
  assert.equal(full.store.contextTier, 4, '100% = 全响应');

  // 老配置（四段式，没打标记）保存时换算：老 1/2 档不掷骰子 → 0%
  const legacy1 = updateConfig({ store: { contextSliderPos: 5, sliderMode: '', contextTier: 1, randomPercent: 0 } });
  assert.equal(legacy1.store.randomPercent, 0, '老 1 档（仅艾特）迁移成 0%');
  const legacy2 = updateConfig({ store: { contextSliderPos: 15, sliderMode: '', contextTier: 2, randomPercent: 0 } });
  assert.equal(legacy2.store.randomPercent, 0, '老 2 档（+关键词）迁移成 0%');
  const legacy3 = updateConfig({ store: { contextSliderPos: 55, sliderMode: '', contextTier: 3, randomPercent: 50 } });
  assert.equal(legacy3.store.randomPercent, 50, '老 3 档的概率原样保留');
  const legacy4 = updateConfig({ store: { contextSliderPos: 95, sliderMode: '', contextTier: 4, randomPercent: 100 } });
  assert.equal(legacy4.store.randomPercent, 100, '老 4 档（全响应）迁移成 100%');
  assert.equal(legacy4.store.sliderMode, 'probability', '迁移后要打上标记，别重复换算');

  // 老配置连滑条位置都没有（只有 tier/概率）也要能迁
  const legacyNoPos = updateConfig({ store: { contextSliderPos: null, sliderMode: '', contextTier: 3, randomPercent: 24.3 } });
  assert.equal(legacyNoPos.store.randomPercent, 24.3);
  const legacyNoPos4 = updateConfig({ store: { contextSliderPos: null, sliderMode: '', contextTier: 4, randomPercent: 0 } });
  assert.equal(legacyNoPos4.store.randomPercent, 100, '老 4 档没有位置时按全响应');

  // 分群滑条（存的是概率）跟着迁移
  const grouped = updateConfig({
    store: { sliderMode: '', contextTier: 4, randomPercent: 100, groupSliderPos: { '111': 5, '222': 55 } }
  });
  assert.deepEqual(grouped.store.groupSliderPos, { '111': 0, '222': 50 }, '分群的老位置也要换算成概率');
  // 界面保存分群表时带 __replace__（删掉的群要真删），这里用同一套写法
  const groupedNew = updateConfig({
    store: { sliderMode: 'probability', groupSliderPos: { __replace__: { '111': 30 } } }
  });
  assert.deepEqual(groupedNew.store.groupSliderPos, { '111': 30 }, '新语义下原样保留');
});
