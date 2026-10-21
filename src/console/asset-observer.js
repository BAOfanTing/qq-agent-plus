import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../core/sqlite.js';
import { DATA_DIR } from '../core/config.js';
import { IdentityStore, identityDatabasePath } from '../identity/identity-store.js';
import { normalizeStickerEntry } from '../onebot/stickers.js';

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function cleanText(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function slangFile(dataDir) {
  return path.join(dataDir, 'slang.json');
}

function slangRecord(entry, index = 0, { strictStatus = false } = {}) {
  const rawStatus = entry?.status;
  if (
    strictStatus
    && rawStatus !== undefined
    && !['candidate', 'confirmed', 'rejected'].includes(rawStatus)
  ) {
    throw new Error('黑话状态必须是 candidate、confirmed 或 rejected');
  }
  const status = ['candidate', 'confirmed', 'rejected'].includes(rawStatus)
    ? rawStatus
    : 'candidate';
  return {
    ...(entry && typeof entry === 'object' ? entry : {}),
    id: cleanText(entry?.id || `slang-${index + 1}`, 100),
    content: cleanText(entry?.content, 80),
    meaning: cleanText(entry?.meaning, 500),
    usage: cleanText(entry?.usage, 300),
    example: cleanText(entry?.example, 300),
    risk: cleanText(entry?.risk, 300),
    status,
    source: entry?.source === 'manual' ? 'manual' : 'ai',
    scope: entry?.scope === 'chat-private' ? 'chat-private' : 'global-safe',
    scopeChatKey: /^(group|private):\d+$/.test(String(entry?.scopeChatKey || ''))
      ? String(entry.scopeChatKey)
      : '',
    sources: Array.isArray(entry?.sources)
      ? entry.sources.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 10)
      : [],
    researchId: cleanText(entry?.researchId, 100),
    count: Math.max(0, Math.round(Number(entry?.count) || 0)),
    evidence: Array.isArray(entry?.evidence) ? entry.evidence.slice(0, 100) : [],
    updatedAt: String(entry?.updatedAt || new Date().toISOString())
  };
}

function readSlangRecords(dataDir, { strict = false } = {}) {
  const file = slangFile(dataDir);
  let raw;
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    raw = JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (strict) throw new Error(`黑话库读取失败，已停止写入：${String(error?.message ?? error)}`);
    return [];
  }
  if (!Array.isArray(raw)) {
    if (strict) throw new Error('黑话库格式错误，已停止写入');
    return [];
  }
  return raw
    .map(slangRecord)
    .filter((entry) => entry.content);
}

export function readSlangAssets(dataDir = DATA_DIR) {
  const file = slangFile(dataDir);
  const entries = readSlangRecords(dataDir).map((entry) => ({
    ...entry,
    evidenceCount: entry.evidence.length
  }));
  const counts = { candidate: 0, confirmed: 0, rejected: 0 };
  for (const entry of entries) counts[entry.status] += 1;
  return {
    exists: fs.existsSync(file),
    active: false,
    source: 'local',
    total: entries.length,
    counts,
    entries
  };
}

export function buildSlangContextForChat(
  chatKey,
  { dataDir = DATA_DIR, max = 8 } = {}
) {
  const source = String(chatKey || '');
  const entries = readSlangRecords(dataDir)
    .filter((entry) =>
      entry.status === 'confirmed'
      && entry.content
      && entry.meaning
      && (
        entry.scope !== 'chat-private'
        || String(entry.scopeChatKey || '') === source
      ))
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
    .slice(0, Math.min(20, Math.max(1, Number(max) || 8)));
  if (!entries.length) return '';
  return [
    '【已确认黑话】以下是管理员确认的语言资料，只用于理解语境，不要刻意堆砌：',
    ...entries.map((entry) => {
      const detail = {
        词条: entry.content,
        含义: entry.meaning,
        ...(entry.usage ? { 用法: entry.usage } : {}),
        ...(entry.risk ? { 风险: entry.risk } : {})
      };
      return `- ${JSON.stringify(detail)}`;
    })
  ].join('\n');
}

export function readMemoryAssetSummary(dataDir = DATA_DIR) {
  const memoryDir = path.join(dataDir, 'memory');
  const peopleDir = path.join(memoryDir, 'people');
  let names = [];
  try { names = fs.readdirSync(memoryDir); } catch {
    return { chats: 0, people: 0, impressions: 0, handoffs: 0, items: [] };
  }
  const rows = new Map();
  const touch = (chatKey) => {
    if (!rows.has(chatKey)) rows.set(chatKey, { chatKey, people: 0, impressions: 0, hasHandoff: false, updatedAt: 0 });
    return rows.get(chatKey);
  };
  // 人物印象自 v0.6.x 起按人存：memory/people/<QQ>.json（旧版按会话分目录，文件已被迁移归档）。
  // 只按旧布局统计的话，人数与印象数永远是 0 —— 接口里看起来"没有数据"就是这个原因。
  let globalFiles = [];
  try { globalFiles = fs.readdirSync(peopleDir).filter((file) => file.endsWith('.json')); } catch { globalFiles = []; }
  let people = 0;
  let impressions = 0;
  for (const file of globalFiles) {
    const target = path.join(peopleDir, file);
    const value = readJson(target, null);
    if (!value) continue;
    people += 1;
    const list = Array.isArray(value.impressions) ? value.impressions : [];
    impressions += list.length;
    let updatedAt = Number(value.updatedAt) || 0;
    try { updatedAt = Math.max(updatedAt, fs.statSync(target).mtimeMs); } catch { /* ignore */ }
    const keys = new Set();
    for (const key of Array.isArray(value.sourceChatKeys) ? value.sourceChatKeys : []) keys.add(String(key));
    for (const item of list) for (const key of Array.isArray(item?.sourceChatKeys) ? item.sourceChatKeys : []) keys.add(String(key));
    for (const key of keys) {
      if (!/^(group|private):\d+$/.test(key)) continue;
      const row = touch(key);
      row.people += 1;
      // 按条目自己的来源算：没写来源的旧条目，算在它会出现的每个会话里
      row.impressions += list.filter((item) => {
        const sources = Array.isArray(item?.sourceChatKeys) ? item.sourceChatKeys : [];
        return !sources.length || sources.includes(key);
      }).length;
      row.updatedAt = Math.max(row.updatedAt, updatedAt);
    }
  }
  for (const name of names) {
    const full = path.join(memoryDir, name);
    const match = /^(group|private)_(\d+)$/.exec(name);
    if (!match) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(full); } catch { continue; }
    const row = touch(`${match[1]}:${match[2]}`);
    if (files.includes('_handoff.json')) {
      row.hasHandoff = true;
      try { row.updatedAt = Math.max(row.updatedAt, fs.statSync(path.join(full, '_handoff.json')).mtimeMs); } catch { /* ignore */ }
    }
    // 旧布局残留（还没跑过迁移的机器）：只在没有全局人物文件时兜底计数，避免同一份印象被算两遍
    if (!globalFiles.length) {
      for (const file of files) {
        if (!/^\d{1,15}\.json$/.test(file)) continue;
        const target = path.join(full, file);
        const value = readJson(target, null);
        if (!value) continue;
        row.people += 1;
        row.impressions += Array.isArray(value.impressions) ? value.impressions.length : 0;
        try { row.updatedAt = Math.max(row.updatedAt, fs.statSync(target).mtimeMs); } catch { /* ignore */ }
      }
    }
  }
  const items = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    chats: items.length,
    people: globalFiles.length ? people : items.reduce((sum, chat) => sum + chat.people, 0),
    impressions: globalFiles.length ? impressions : items.reduce((sum, chat) => sum + chat.impressions, 0),
    handoffs: items.filter((chat) => chat.hasHandoff).length,
    items
  };
}

export function readIdentityAssets(dataDir = DATA_DIR, limit = 500, query = '') {
  const file = identityDatabasePath(dataDir);
  if (!fs.existsSync(file)) {
    return { exists: false, people: 0, sources: 0, aliases: 0, entries: [] };
  }
  let db;
  try {
    db = openDatabase(file, { readOnly: true });
    const hasOverrides = Boolean(db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='identity_asset_overrides'
    `).get());
    const totals = {
      people: Number(db.prepare('SELECT COUNT(*) AS n FROM people').get().n) || 0,
      sources: Number(db.prepare('SELECT COUNT(*) AS n FROM identity_sources').get().n) || 0,
      aliases: Number(db.prepare('SELECT COUNT(*) AS n FROM identity_aliases').get().n) || 0
    };
    const q = cleanText(query, 100).toLowerCase();
    const pattern = `%${q}%`;
    const rows = db.prepare(hasOverrides ? `
      SELECT p.uin, p.primary_name, p.message_count, p.chat_count, p.is_friend,
        p.legacy_memory_count, p.first_seen_at, p.last_seen_at, p.profile_json,
        CASE WHEN o.uin IS NULL THEN 0 ELSE 1 END AS manually_managed,
        COALESCE(
          NULLIF(o.source_chat_key, ''),
          (SELECT s.chat_key FROM identity_sources s
            WHERE s.uin=p.uin ORDER BY s.last_seen_at DESC LIMIT 1),
          ''
        ) AS manual_source_chat_key
      FROM people p
      LEFT JOIN identity_asset_overrides o ON o.uin=p.uin AND o.deleted=0
      WHERE ?='' OR lower(p.uin) LIKE ? OR lower(p.primary_name) LIKE ?
        OR lower(p.profile_json) LIKE ?
        OR EXISTS (
          SELECT 1 FROM identity_aliases a
          WHERE a.uin=p.uin AND lower(a.alias) LIKE ?
        )
      ORDER BY p.last_seen_at DESC, p.message_count DESC, p.uin LIMIT ?
    ` : `
      SELECT uin, primary_name, message_count, chat_count, is_friend,
        legacy_memory_count, first_seen_at, last_seen_at, profile_json,
        0 AS manually_managed,
        COALESCE(
          (SELECT s.chat_key FROM identity_sources s
            WHERE s.uin=people.uin ORDER BY s.last_seen_at DESC LIMIT 1),
          ''
        ) AS manual_source_chat_key
      FROM people
      WHERE ?='' OR lower(uin) LIKE ? OR lower(primary_name) LIKE ?
        OR lower(profile_json) LIKE ?
        OR EXISTS (
          SELECT 1 FROM identity_aliases a
          WHERE a.uin=people.uin AND lower(a.alias) LIKE ?
        )
      ORDER BY last_seen_at DESC, message_count DESC, uin LIMIT ?
    `).all(
      q,
      pattern,
      pattern,
      pattern,
      pattern,
      Math.min(500, Math.max(1, Number(limit) || 500))
    );
    const aliasStmt = db.prepare(`
      SELECT alias FROM identity_aliases WHERE uin=?
      ORDER BY last_seen_at DESC, seen_count DESC LIMIT 8
    `);
    const entries = rows.map((row) => ({
        userId: String(row.uin),
        primaryName: String(row.primary_name || ''),
        messageCount: Number(row.message_count) || 0,
        chatCount: Number(row.chat_count) || 0,
        isFriend: Boolean(row.is_friend),
        manuallyManaged: Boolean(row.manually_managed),
        sourceChatKey: String(row.manual_source_chat_key || ''),
        legacyMemoryCount: Number(row.legacy_memory_count) || 0,
        profileNote: (() => {
          try {
            return cleanText(JSON.parse(row.profile_json || '{}')?.note, 300);
          } catch {
            return '';
          }
        })(),
        firstSeenAt: Number(row.first_seen_at) || 0,
        lastSeenAt: Number(row.last_seen_at) || 0,
        aliases: [...new Set(aliasStmt.all(row.uin)
          .map((entry) => cleanText(entry.alias, 60))
          .filter(Boolean))]
      }));
    return {
      exists: true,
      ...totals,
      matched: entries.length,
      entries
    };
  } catch (error) {
    return {
      exists: true,
      people: 0,
      sources: 0,
      aliases: 0,
      entries: [],
      error: String(error?.message ?? error)
    };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function stickerView(entry) {
  const normalized = normalizeStickerEntry(entry);
  if (!normalized || normalized.hidden) return null;
  return {
    id: normalized.id,
    desc: normalized.desc,
    localNote: normalized.localNote,
    tags: normalized.tags,
    usage: normalized.usage,
    source: normalized.source,
    useCount: normalized.useCount,
    lastUsedAt: normalized.lastUsedAt,
    lastContext: normalized.lastContext,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    hasImage: Boolean(normalized.url)
      || Boolean(normalized.localFile)
  };
}

export class AssetObserver {
  constructor({
    stickers,
    memory,
    getIdentityPilot = () => null,
    getIdentityStatus = () => null,
    dataDir = DATA_DIR,
    // 会话仓库：用来把「非会话类」的模型调用记进今日用量台账。
    // 表情备注每张都要花 token，不能只显示在进度条上，否则"今日花费"与预算判定都偏乐观
    //（与 orchestrator / group-digest 同一条口径：recordExternalUsage）。
    sessions = null
  }) {
    this.stickers = stickers;
    this.memory = memory;
    this.getIdentityPilot = getIdentityPilot;
    this.getIdentityStatus = getIdentityStatus;
    this.dataDir = dataDir;
    this.sessions = sessions;
  }

  addSticker(input) {
    return stickerView(this.stickers.addManual(input));
  }

  updateSticker(id, patch) {
    return stickerView(this.stickers.update(id, patch));
  }

  deleteSticker(id) {
    return this.stickers.remove(id);
  }

  /**
   * 批量给**没有备注**的表情补写 AI 备注（控制台「重新备注」按钮）。
   *
   * 判定"没备注"：`localNote` 和 `usage` 都为空（`desc` 是 QQ 那边带过来的表情名或文件名，
   * 不算"有人看过这张图并写过说明"）。
   *
   * ⚠️ 图片从哪来：贴纸库以 **QQ 收藏表情**为主（实测 135 条里 134 条 source=qq），
   * 这些条目**没有 localFile**，只有一个 `p.qpic.cn/qq_expression/…` 的 url。
   * 早先只查本地文件，结果 112 条"没备注"的**全部被当成没有图跳过**了。
   * 正确做法：有本地文件读文件，没有就按 url 下载（走 safeFetchBinary 那套守卫）。
   *
   * ⚠️ 参数**不用解构默认值**：`ops.js scan --strict` 认不出"解构参数里的回调"，
   * 会把 `progress` 报成"可疑未定义调用点"导致 CI 红（KNOWN_IGNORE 里那句
   * "解构参数默认值超出扫描器识别范围"说的就是这个）。所以逐个从 options 上取。
   *
   * @param options.max 本次最多处理几条（默认 10）—— 一条一次视觉调用，贪多会让整页卡很久
   * @param options.progress 每处理完一条回调一次（前端做进度显示）
   * @param options.id 只处理**这一条**（按 id 精确指定）
   *
   * ⚠️ `options.id` 不是可选的锦上添花，是**修一个真实 bug 的必需项**：
   * 早先前端逐条发 `max:1`、每次由后端取「待备注队列的头一个」。某条失败后它仍留在队首，
   * 下一次请求还是处理它 —— 于是
   *   ① 前端用 previews[i] 显示的缩略图与后端实际处理的图从第一次失败起**永久错位**；
   *   ② 一张坏图（下载失败 / 写入不落地）会把用户选的全部张数**烧光在同一张上**
   *      （2026-10-20 实测：连调 3 次 max:1，3 次都是同一张 ZZTEST_broken_1）。
   * 按 id 处理就没有"谁在队首"这回事：前端拿 previews 里的 id 逐个点名，失败也只是那一条失败。
   */
  async renoteMissingStickers(options = {}) {
    const max = Number(options?.max) || 10;
    const progress = typeof options?.progress === 'function' ? options.progress : null;
    const { signal } = options || {};
    const onlyId = String(options?.id ?? '').trim();
    const entries = (this.stickers?.entries || []).filter(Boolean);
    // ⚠️ **必须排除 hidden 条目**（2026-10-20 实测踩到的坑）：
    // 库里有一批 `hidden: true` 的条目（占位/已失效的），它们没有 localNote，
    // 于是每次都排在候选第一位、被反复拿去请求模型 —— 而 `stickerView` 又会把这些条目过滤掉，
    // 结果是：每点一次都消耗 token、`annotated` 一个都不涨、还总是同一张图。
    const visible = entries.filter((entry) => entry.hidden !== true);
    const missing = visible.filter((entry) => !String(entry.localNote || '').trim() && !String(entry.usage || '').trim());
    // 有没有可用的图：本地文件 或 QQ 收藏带的图链。
    // ⚠️ 这里遍历的是**原始条目**（this.stickers.entries），不是 stickerView 包装过的对象 ——
    // 原始条目上没有 hasImage 字段，早先写 entry.hasImage 导致 111 条全部被当成"没有图"跳过。
    const usable = missing.filter((entry) => entry.localFile || entry.url);

    // 指定了 id 就只处理那一条（不看它在队列里的位置）。找不到/已不符条件时如实报错，
    // 不回退成"取队首" —— 那会让前端以为处理的是 A、实际处理的是 B。
    let targets;
    if (onlyId) {
      const hit = usable.find((entry) => entry.id === onlyId || entry.resId === onlyId);
      if (!hit) {
        // 可能已被别处补上备注了：这不算错误，返回 attempted:0 让前端跳过
        const exists = visible.some((entry) => entry.id === onlyId || entry.resId === onlyId);
        return {
          total: visible.length,
          missing: missing.length,
          skippedNoImage: 0,
          attempted: 0,
          updated: 0,
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          failed: [],
          items: [],
          note: exists ? '这一条已经有备注了（或没有可用图片），跳过' : `找不到这个表情：${onlyId}`
        };
      }
      targets = [hit];
    } else {
      targets = usable.slice(0, Math.max(1, Math.min(50, Number(max) || 10)));
    }

    const result = {
      total: visible.length,
      missing: missing.length,        // 没备注的
      skippedNoImage: missing.length - usable.length,  // 既没有文件也没有图链（少见）
      attempted: targets.length,
      updated: 0,
      // 本次消耗的 token（含重试）。前端进度条要显示"这次花了多少"
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      failed: [],
      items: []
    };
    // 连续失败计数：单次失败（模型抽风、某张图异常）不该中止整批，**连续**才说明是系统性问题。
    // 实测 glm-5.2 看图是随机抖动的（第 1 张说看不到图、第 2 张却成功、第 3 张又说看不到），
    // 按"一失败就停"会把能成功的那几张也一起跳掉。
    const ABORT_AFTER_CONSECUTIVE = 2;
    let consecutiveFailures = 0;
    let consecutiveRateLimited = 0;
    for (const [index, entry] of targets.entries()) {
      if (signal?.aborted) break;
      let usage = null;
      try {
        // 只传 id：取本地文件还是下载图链，由贴纸库自己判断（url 不对观测层暴露）
        const note = await this.stickers.annotateStickerImage({ ref: entry.id });
        usage = note?.usage || null;
        if (!note?.ok) {
          result.failed.push({
            id: entry.id,
            reason: note?.reason || '没拿到备注',
            rateLimited: note?.rateLimited === true
          });
          // 限流单独计数：连续限流说明请求太快，本轮该收手让用户等一下
          consecutiveRateLimited = note?.rateLimited ? consecutiveRateLimited + 1 : 0;
          if (consecutiveRateLimited >= ABORT_AFTER_CONSECUTIVE) {
            result.aborted = true;
            result.abortKind = 'rate-limit';
            result.abortReason = '连续被限流（请求太快），先停一下，等几秒再继续';
            break;
          }
          // 模型看不到图：连续两次才中止（单次可能只是抽风）
          consecutiveFailures = note?.cannotSeeImage ? consecutiveFailures + 1 : 0;
          if (consecutiveFailures >= ABORT_AFTER_CONSECUTIVE) {
            result.aborted = true;
            result.abortKind = 'no-vision';
            result.abortReason = `${note.reason}（连续 ${consecutiveFailures} 张都看不到图，已停止）`;
            break;
          }
          continue;
        }
        // 成功一次就把连续计数清零
        consecutiveFailures = 0;
        consecutiveRateLimited = 0;
        const patch = { localNote: note.note };
        // 只在原来没有标签时才补，避免覆盖用户自己打的标签
        if (!(entry.tags || []).length && note.tags?.length) patch.tags = note.tags;
        const saved = this.stickers.update(entry.id, patch);
        // 回读校验：写入没落地时不能报"已补 N 条"（真实踩过：隐藏条目写不进去，
        // 界面显示成功但 annotated 一个没涨、下一轮还是同一张图）。
        const persisted = String(saved?.localNote || '').trim() || String(
          (this.stickers?.entries || []).find((e) => e.id === entry.id)?.localNote || ''
        ).trim();
        if (!persisted) {
          result.failed.push({ id: entry.id, reason: '备注写入没有落地（条目可能是隐藏/只读的）' });
          continue;
        }
        result.updated += 1;
        result.items.push({
          id: entry.id,
          note: note.note,
          ok: true,
          // 给进度条显示缩略图用：带图链的条目回传图链，本地文件的走 /api/assets/stickers/image?id=
          imageUrl: entry.localFile ? '' : String(entry.url || ''),
          hasLocalFile: Boolean(entry.localFile)
        });
      } catch (error) {
        result.failed.push({ id: entry.id, reason: String(error?.message ?? error) });
      } finally {
        // 成功失败都要记 token：失败的调用也真的花掉了
        if (usage) {
          result.tokens.promptTokens += Number(usage.promptTokens) || 0;
          result.tokens.completionTokens += Number(usage.completionTokens) || 0;
          result.tokens.totalTokens += Number(usage.totalTokens) || 0;
          // 记进「今日用量」台账：表情备注属于**非会话类**模型调用（与记忆整理、群日报同类），
          // 花的是真钱。早先只把数字显示在进度条上，控制台的"今日花费"和预算判定都不知道这笔账。
          // 失败也记（above 已经算进 tokens），口径与 #recordExternalUsage 一致：不计 runs。
          try {
            this.sessions?.recordExternalUsage?.({
              promptTokens: Number(usage.promptTokens) || 0,
              completionTokens: Number(usage.completionTokens) || 0,
              totalTokens: Number(usage.totalTokens) || 0,
              cachedTokens: Number(usage.cachedTokens) || 0
            }, { model: usage.model || '' });
          } catch { /* 记账失败不该让备注本身失败 */ }
        }
      }
      if (progress) {
        try {
          progress({
            done: index + 1,
            total: targets.length,
            id: entry.id,
            tokens: { ...result.tokens }
          });
        } catch { /* 回调不该影响主流程 */ }
      }
    }
    return result;
  }

  stickerSnapshot() {
    const entries = (this.stickers?.entries || []).map(stickerView).filter(Boolean);
    return {
      enabled: this.stickers?.enabled !== false,
      syncedAt: Number(this.stickers?.syncedAt) || 0,
      total: entries.length,
      // 「已备注」只看 localNote（AI 写过的那句说明）。
      // ⚠️ 早先的口径是 `desc || localNote || tags || usage`，但 QQ 收藏的表情**天生带 desc**
      // （QQ 那边给的表情名，如「早安」「甚惊之」），于是这些条目在 AI 写备注之前就已经被
      // 算成"已备注"了 —— 用户点完「重新备注」，这个数字一点没变就是这么来的（2026-10-20 实测：
      // 135 条里 43 条按旧口径算"已备注"，而真正有 localNote 的只有 38 条）。
      annotated: entries.filter((entry) => String(entry.localNote || '').trim()).length,
      used: entries.filter((entry) => entry.useCount > 0).length,
      sources: {
        qq: entries.filter((entry) => entry.source === 'qq').length,
        ai: entries.filter((entry) => entry.source === 'ai').length,
        manual: entries.filter((entry) => entry.source === 'manual').length
      },
      entries
    };
  }

  async listStickers({ query = '', offset = 0, limit = 100, refresh = false } = {}) {
    let sync = null;
    if (refresh) sync = await this.stickers.sync(true);
    const snapshot = this.stickerSnapshot();
    const q = cleanText(query, 100).toLowerCase();
    const filtered = q
      ? snapshot.entries.filter((entry) =>
          [
            entry.id,
            entry.desc,
            entry.localNote,
            entry.usage,
            ...entry.tags
          ].join(' ').toLowerCase().includes(q))
      : snapshot.entries;
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(200, Math.max(1, Number(limit) || 100));
    return {
      ...snapshot,
      matched: filtered.length,
      offset: start,
      limit: size,
      entries: filtered.slice(start, start + size),
      refreshError: String(sync?.error || '')
    };
  }

  listSlang({ query = '', status = '', offset = 0, limit = 200 } = {}) {
    const snapshot = readSlangAssets(this.dataDir);
    const q = cleanText(query, 100).toLowerCase();
    const wantedStatus = ['candidate', 'confirmed', 'rejected'].includes(status)
      ? status
      : '';
    const filtered = snapshot.entries.filter((entry) =>
      (!wantedStatus || entry.status === wantedStatus)
      && (!q || [
        entry.content,
        entry.meaning,
        entry.usage,
        entry.example,
        entry.risk
      ].join(' ').toLowerCase().includes(q)));
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(500, Math.max(1, Number(limit) || 200));
    return {
      ...snapshot,
      matched: filtered.length,
      offset: start,
      limit: size,
      entries: filtered.slice(start, start + size)
    };
  }

  addSlang(input = {}) {
    const content = cleanText(input.content, 80);
    if (!content) throw new Error('黑话词条不能为空');
    const scope = input.scope === 'chat-private' ? 'chat-private' : 'global-safe';
    const scopeChatKey = cleanText(input.scopeChatKey, 100);
    if (scope === 'chat-private' && !/^(group|private):\d+$/.test(scopeChatKey)) {
      throw new Error('群内黑话必须指定有效来源会话');
    }
    const entries = readSlangRecords(this.dataDir, { strict: true });
    if (entries.some((entry) =>
      entry.content.toLowerCase() === content.toLowerCase()
      && entry.scope === scope
      && (scope !== 'chat-private' || entry.scopeChatKey === scopeChatKey))) {
      throw new Error('黑话词条已存在');
    }
    const entry = slangRecord({
      id: `slang_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
      content,
      meaning: input.meaning,
      usage: input.usage,
      example: input.example,
      risk: input.risk,
      status: input.status,
      source: 'manual',
      scope,
      scopeChatKey: scope === 'chat-private' ? scopeChatKey : '',
      count: input.count,
      evidence: [],
      updatedAt: new Date().toISOString()
    }, entries.length, { strictStatus: true });
    entries.push(entry);
    writeJson(slangFile(this.dataDir), entries);
    return { ...entry, evidenceCount: 0 };
  }

  admitSlangCandidate(input = {}) {
    const content = cleanText(input.content, 80);
    if (!content) throw new Error('黑话词条不能为空');
    const entries = readSlangRecords(this.dataDir, { strict: true });
    const normalized = content.normalize('NFKC').toLowerCase();
    const scope = input.scope === 'global-safe' ? 'global-safe' : 'chat-private';
    const scopeChatKey = cleanText(input.scopeChatKey, 100);
    if (scope === 'chat-private' && !/^(group|private):\d+$/.test(scopeChatKey)) {
      throw new Error('群内黑话必须指定有效来源会话');
    }
    const index = entries.findIndex((entry) =>
      entry.content.normalize('NFKC').toLowerCase() === normalized
      && entry.scope === scope
      && (scope !== 'chat-private' || entry.scopeChatKey === scopeChatKey));
    const existing = index >= 0 ? entries[index] : null;
    const incomingEvidence = Array.isArray(input.evidence)
      ? input.evidence.filter((item) => item && typeof item === 'object').slice(-30)
      : [];
    const evidence = [...(existing?.evidence || [])];
    const seen = new Set(evidence.map((item) => String(item.key || JSON.stringify(item))));
    for (const item of incomingEvidence) {
      const key = String(item.key || JSON.stringify(item));
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(item);
    }
    const entry = slangRecord({
      ...(existing || {}),
      id: existing?.id || `slang_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
      content,
      meaning: cleanText(input.meaning ?? existing?.meaning, 500),
      usage: cleanText(input.usage ?? existing?.usage, 300),
      example: cleanText(input.example ?? existing?.example, 300),
      risk: cleanText(input.risk ?? existing?.risk, 300),
      status: existing?.status === 'confirmed' ? 'confirmed' : 'candidate',
      source: existing?.source === 'manual' ? 'manual' : 'ai',
      count: Math.max(
        Number(existing?.count) || 0,
        Math.max(1, Number(input.count) || 1)
      ),
      evidence: evidence.slice(-30),
      scope,
      scopeChatKey: scope === 'chat-private' ? scopeChatKey : '',
      sources: Array.isArray(input.sources)
        ? input.sources.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 10)
        : (existing?.sources || []),
      researchId: cleanText(input.researchId, 100),
      updatedAt: new Date().toISOString()
    }, index >= 0 ? index : entries.length, { strictStatus: true });
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
    writeJson(slangFile(this.dataDir), entries);
    return { ...entry, evidenceCount: entry.evidence.length };
  }

  updateSlang(id, patch = {}) {
    const entries = readSlangRecords(this.dataDir, { strict: true });
    const index = entries.findIndex((entry) => entry.id === String(id || ''));
    if (index < 0) return null;
    const scope = patch.scope !== undefined
      ? (patch.scope === 'chat-private' ? 'chat-private' : 'global-safe')
      : entries[index].scope;
    const scopeChatKey = patch.scopeChatKey !== undefined
      ? cleanText(patch.scopeChatKey, 100)
      : entries[index].scopeChatKey;
    if (scope === 'chat-private' && !/^(group|private):\d+$/.test(scopeChatKey)) {
      throw new Error('群内黑话必须指定有效来源会话');
    }
    const next = slangRecord({
      ...entries[index],
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.meaning !== undefined ? { meaning: patch.meaning } : {}),
      ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
      ...(patch.example !== undefined ? { example: patch.example } : {}),
      ...(patch.risk !== undefined ? { risk: patch.risk } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.count !== undefined ? { count: patch.count } : {}),
      scope,
      scopeChatKey: scope === 'chat-private' ? scopeChatKey : '',
      updatedAt: new Date().toISOString()
    }, index, { strictStatus: true });
    if (!next.content) throw new Error('黑话词条不能为空');
    if (entries.some((entry, entryIndex) =>
      entryIndex !== index
      && entry.content.toLowerCase() === next.content.toLowerCase()
      && entry.scope === next.scope
      && (
        next.scope !== 'chat-private'
        || entry.scopeChatKey === next.scopeChatKey
      ))) {
      throw new Error('黑话词条已存在');
    }
    entries[index] = next;
    writeJson(slangFile(this.dataDir), entries);
    return { ...next, evidenceCount: next.evidence.length };
  }

  deleteSlang(id) {
    const entries = readSlangRecords(this.dataDir, { strict: true });
    const next = entries.filter((entry) => entry.id !== String(id || ''));
    if (next.length === entries.length) return false;
    writeJson(slangFile(this.dataDir), next);
    return true;
  }

  overview() {
    const stickers = this.stickerSnapshot();
    const slang = readSlangAssets(this.dataDir);
    const memory = readMemoryAssetSummary(this.dataDir);
    const identityRuntime = this.getIdentityStatus?.() || {
      enabled: false,
      active: false,
      people: 0,
      databaseExists: false
    };
    const identityStored = readIdentityAssets(this.dataDir, 1);
    const identity = {
      ...identityRuntime,
      databaseExists: identityStored.exists,
      people: identityRuntime.active ? identityRuntime.people : identityStored.people,
      sources: identityRuntime.active ? identityRuntime.sources : identityStored.sources,
      aliases: identityRuntime.active ? identityRuntime.aliases : identityStored.aliases
    };
    return {
      generatedAt: Date.now(),
      stickers: {
        enabled: stickers.enabled,
        syncedAt: stickers.syncedAt,
        total: stickers.total,
        annotated: stickers.annotated,
        used: stickers.used,
        sources: stickers.sources
      },
      slang: {
        exists: slang.exists,
        active: slang.active,
        total: slang.total,
        counts: slang.counts
      },
      memory: {
        chats: memory.chats,
        people: memory.people,
        impressions: memory.impressions,
        handoffs: memory.handoffs,
        items: memory.items
      },
      identity
    };
  }

  memorySummary({ query = '', limit = 0 } = {}) {
    const summary = readMemoryAssetSummary(this.dataDir);
    if (!this.memory) return summary;
    const q = cleanText(query, 100).toLowerCase();
    const members = [];
    for (const chatKey of this.memory.listChats()) {
      for (const member of this.memory.members(chatKey)) {
        const entry = {
          chatKey,
          userId: String(member.userId || ''),
          name: String(member.name || ''),
          impressions: (member.impressions || []).map((item) => ({
            content: cleanText(item.content, 300),
            createdAt: Number(item.createdAt) || 0
          })),
          updatedAt: Number(member.updatedAt) || 0
        };
        if (
          q
          && ![
            entry.chatKey,
            entry.userId,
            entry.name,
            ...entry.impressions.map((item) => item.content)
          ].join(' ').toLowerCase().includes(q)
        ) continue;
        members.push(entry);
      }
    }
    members.sort((a, b) => b.updatedAt - a.updatedAt);
    // limit>0 时只回最近更新的那些（这个接口是"每个会话 × 每个成员"的全量遍历，
    // 多群实例能到上千行 —— 全量回给前端等于让它一次性渲染上千行表格）。
    // 带上 total，界面才能说清楚"只列了最近 N 条"（2026-10-08 审查）。
    const cap = Number(limit) > 0 ? Math.max(1, Math.min(2000, Math.round(Number(limit)))) : 0;
    return {
      ...summary,
      entries: cap && members.length > cap ? members.slice(0, cap) : members,
      total: members.length
    };
  }

  addMemory({ chatKey, userId, name = '', content }) {
    const source = String(chatKey || '');
    if (!/^(group|private):\d+$/.test(source)) throw new Error('会话格式无效');
    const uin = String(userId || '').trim();
    const text = cleanText(content, 300);
    if (!/^\d{1,15}$/.test(uin)) throw new Error('QQ 号必须为正整数');
    if (!text) throw new Error('记忆内容不能为空');
    const entry = this.memory?.append(source, 'memberImpression', text, {
      userId: uin,
      target: cleanText(name, 60),
      origin: 'manual'   // 控制台手动新增的，不是模型自己记的
    });
    if (!entry) throw new Error('记忆存储不可用');
    return { chatKey: source, userId: uin, ...entry };
  }

  updateMemory({ chatKey, userId, name = '', impressions = [] }) {
    const source = String(chatKey || '');
    if (!/^(group|private):\d+$/.test(source)) throw new Error('会话格式无效');
    if (!this.memory) throw new Error('记忆存储不可用');
    const entries = (Array.isArray(impressions) ? impressions : [impressions])
      .map((entry) => cleanText(entry, 300))
      .filter(Boolean);
    if (!entries.length) throw new Error('至少保留一条记忆；删除请使用删除按钮');
    // 控制台里人手改的：标成 manual，别让它在记忆页显示成"整理改写"
    return this.memory.replaceMember(
      source,
      String(userId || '').trim(),
      cleanText(name, 60),
      entries,
      { origin: 'manual' }
    );
  }

  deleteMemory({ chatKey, userId }) {
    const source = String(chatKey || '');
    if (!/^(group|private):\d+$/.test(source)) throw new Error('会话格式无效');
    return Boolean(this.memory?.removeMember(source, String(userId || '').trim()));
  }

  upsertIdentity(input) {
    const activeStore = this.getIdentityPilot?.()?.identityStore;
    if (activeStore) return activeStore.upsertIdentityAsset(input);
    const store = new IdentityStore({ dataDir: this.dataDir });
    try {
      return store.upsertIdentityAsset(input);
    } finally {
      store.close();
    }
  }

  deleteIdentity(userId) {
    const activeStore = this.getIdentityPilot?.()?.identityStore;
    if (activeStore) return activeStore.deleteIdentityAsset(userId);
    const store = new IdentityStore({ dataDir: this.dataDir });
    try {
      return store.deleteIdentityAsset(userId);
    } finally {
      store.close();
    }
  }

  identitySnapshot({ limit = 500, query = '' } = {}) {
    return readIdentityAssets(this.dataDir, limit, query);
  }
}
