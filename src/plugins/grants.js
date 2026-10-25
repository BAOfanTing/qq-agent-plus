// 插件高风险动作的 owner 授权、待批队列、写审计与每日配额（apiVersion 2）。
//
// v2.1 的授权是**对象级**的：一次批准绑定 (插件, 动作, 目标) —— 批"点赞 BV1xx"就只能点
// 这一条视频，模型换一个目标就要重新申请。目标从工具调用的参数里取（manifest 声明
// actionTarget），宿主在调用插件之前拦截判定，插件自己的 cap.approval.check 降级为兼容路径。
//
// 待批（pending）：模型第一次调写工具 → 宿主生成一条待批请求（带目标与预览）→
// 控制台待批列表 + 管理员私聊同时可见 → 管理员在控制台点批准或在私聊回「同意」→
// 生成一张对象级通行证（默认 10 分钟、1 次）。默认拒绝：没批、过期、次数用完、目标不匹配
// 全都拒绝；写失败的额度与批准按"确定未执行"退还。
//
// 配额按"插件 + 动作 + 当天"计数，落在宿主侧（插件进程写不到）。跨天自动归零。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ACTION_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TARGET_RE = /^[\w:.\-]{1,120}$/;
const PENDING_ID_RE = /^[\w-]{1,64}$/;
const MAX_TTL_MS = 24 * 3600 * 1000;
const MAX_USES = 1000;
const PENDING_TTL_MS = 10 * 60_000;   // 待批请求本身的寿命：超时自动消失
const MAX_WRITES_KEPT = 100;          // 每个插件保留的写审计条数（控制台"日志"页签用）

const fail = (code, message) => Object.assign(new Error(message), { code });

function grantsDir(dataDir) {
  return path.join(dataDir, 'plugin-grants');
}

function grantsFile(dataDir, pluginId) {
  return path.join(grantsDir(dataDir), `${pluginId}.json`);
}

function pendingFile(dataDir) {
  return path.join(grantsDir(dataDir), 'pending.json');
}

function dayKey(now = Date.now()) {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function load(dataDir, pluginId) {
  try {
    const raw = JSON.parse(fs.readFileSync(grantsFile(dataDir, pluginId), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function save(dataDir, pluginId, value) {
  const dir = grantsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = grantsFile(dataDir, pluginId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadPending(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingFile(dataDir), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function savePending(dataDir, list) {
  const dir = grantsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = pendingFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function assertAction(action) {
  const value = String(action ?? '');
  if (!ACTION_RE.test(value)) throw fail('E_ARGS', 'action 只能是小写字母开头的字母/数字/下划线');
  return value;
}

/**
 * 目标归一化。返回 '' = 没有目标（动作级批准）；null = 给了目标但不合法。
 * 旧实现对非法字符返回 ''，而 '' 在 checkApproval 里是通配 —— 模型随便传个
 * 带 `/`/空格/中文的目标就能拿到一张"批一次、任意目标都能用"的通行证（2026-10-24 审查 P1）。
 */
export function normalizeTarget(target) {
  const value = String(target ?? '').trim();
  if (!value) return '';
  // 不能先截断再校验：批准只绑定前 120 字符，而插件实际收到完整原值 ——
  // 尾部追加非法字符/另一个目标就能绕过对象级批准（2026-10 审查 P2）。
  return TARGET_RE.test(value) ? value : null;
}

/** 预览内容摘要：批准必须绑定"管理员看到的那段内容"，不能只绑目标。 */
function previewKey(preview) {
  const text = String(preview ?? '');
  return text ? crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) : '';
}

function cleanGrants(state, now) {
  // 只清过期；用完（usesLeft=0）的条目留到过期 —— 失败退还要把那一次加回来，
  // 用完即删会让 uses=1 的通行证（最常见）永远退不了。
  const list = Array.isArray(state.approvals) ? state.approvals : [];
  const kept = list.filter((entry) => Number(entry.expiresAt) > now);
  state.approvals = kept;
  return kept;
}

/**
 * 管理员批准一个动作（对象级）。
 * @param {object} options { uses, ttlMs, target, preview, now } —— target 为空 = 动作级（兼容旧路径）；
 *   preview 非空时通行证只对**同一段预览内容**有效（评论/弹幕不能批了 A 文案再发 B 文案）。
 */
export function grantApproval(dataDir, pluginId, action, { uses = 1, ttlMs = 10 * 60_000, target = '', preview = '', previewKey: providedPreviewKey, now = Date.now() } = {}) {
  const key = assertAction(action);
  const count = Math.max(1, Math.min(MAX_USES, Math.floor(Number(uses) || 1)));
  const ttl = Math.max(60_000, Math.min(MAX_TTL_MS, Math.floor(Number(ttlMs) || 10 * 60_000)));
  const wanted = normalizeTarget(target);
  if (wanted === null) throw fail('E_ARGS', '批准目标含非法字符');
  // 待批批准时直接复用登记时对**完整正文**算出的摘要：待批里只存了展示用的前 300 字，
  // 拿它重算会把批准范围缩回前 300 字（2026-10-24 审查 P1）。
  const keyPreview = providedPreviewKey !== undefined ? String(providedPreviewKey || '') : previewKey(preview);
  const state = load(dataDir, pluginId);
  const grants = cleanGrants(state, now);
  // 同 (动作, 目标, 预览) 的重复批准：次数累加、有效期取更晚（不至于把刚批的几分钟覆盖成更短）
  const previous = grants.find((entry) => entry.action === key && String(entry.target || '') === wanted
    && String(entry.previewKey || '') === keyPreview);
  const entry = {
    action: key,
    target: wanted,
    ...(keyPreview ? { previewKey: keyPreview } : {}),
    expiresAt: Math.max(Number(previous?.expiresAt) || 0, now + ttl),
    usesLeft: (Number(previous?.usesLeft) || 0) + count,
    grantedAt: now
  };
  state.approvals = previous
    ? grants.map((item) => (item === previous ? entry : item))
    : [...grants, entry];
  save(dataDir, pluginId, state);
  return { ...entry };
}

/**
 * 检查（并可消费）一次授权。带 target 时只匹配"该目标的授权"或动作级授权；
 * 带 preview 时还必须与批准时的内容摘要一致。
 * @returns {{approved:boolean, reason:string, expiresAt:number, usesLeft:number, receipt?:object}}
 * receipt 用于失败退还：只回 use、不续期 —— 退还的额度立刻对下一次可用。
 */
export function checkApproval(dataDir, pluginId, action, { consume = false, target = '', preview = '', now = Date.now() } = {}) {
  const key = assertAction(action);
  const wanted = normalizeTarget(target);
  const keyPreview = previewKey(preview);
  if (wanted === null) {
    return { approved: false, reason: '写操作目标含非法字符，已拒绝（这次不会生成通配批准）', expiresAt: 0, usesLeft: 0 };
  }
  const state = load(dataDir, pluginId);
  const grants = cleanGrants(state, now);
  const hit = grants.find((entry) => entry.action === key
    && Number(entry.usesLeft) > 0
    && (String(entry.target || '') === '' || String(entry.target) === wanted)
    && String(entry.previewKey || '') === keyPreview);
  if (!hit) {
    state.approvals = grants;
    save(dataDir, pluginId, state);
    const exactExists = grants.some((entry) => entry.action === key);
    const contentMismatch = grants.some((entry) => entry.action === key
      && String(entry.previewKey || '') !== keyPreview
      && (String(entry.target || '') === '' || String(entry.target) === wanted));
    return {
      approved: false,
      reason: contentMismatch
        ? '批准针对的是另一段内容（评论/弹幕的批准绑定正文，改了内容要重新批准）'
        : exactExists
          ? `没有针对目标 ${wanted || '(空)'} 的批准（一次批准只对一个目标有效）`
          : '还没有批准过这个动作',
      expiresAt: 0,
      usesLeft: 0
    };
  }
  if (consume) {
    hit.usesLeft = Number(hit.usesLeft) - 1;
    state.approvals = grants;
    save(dataDir, pluginId, state);
    return {
      approved: true, reason: '', expiresAt: Number(hit.expiresAt),
      usesLeft: Math.max(0, Number(hit.usesLeft)),
      receipt: { action: key, target: String(hit.target || ''), previewKey: String(hit.previewKey || ''), refunded: false }
    };
  }
  state.approvals = grants;
  save(dataDir, pluginId, state);
  return { approved: true, reason: '', expiresAt: Number(hit.expiresAt), usesLeft: Number(hit.usesLeft) };
}

/** 退还一次已消费的授权（写操作"确定未执行"时调用；幂等，一张收据只退一次）。 */
export function refundApproval(dataDir, pluginId, receipt) {
  if (!receipt || receipt.refunded === true || !receipt.action) return false;
  const state = load(dataDir, pluginId);
  const grants = cleanGrants(state, Date.now());
  const hit = grants.find((entry) => entry.action === receipt.action
    && String(entry.target || '') === String(receipt.target || '')
    && String(entry.previewKey || '') === String(receipt.previewKey || ''));
  if (hit) {
    hit.usesLeft = Number(hit.usesLeft) + 1;
    state.approvals = grants;
    save(dataDir, pluginId, state);
  }
  // 过期/已清的授权不复活：退还只对仍在有效期的通行证有意义
  receipt.refunded = true;
  return true;
}

/** 撤销某动作的授权（可带 target 精确撤销；不带 = 撤该动作全部）。 */
export function revokeApproval(dataDir, pluginId, action, target = '') {
  const key = assertAction(action);
  const wanted = target ? normalizeTarget(target) : '';
  if (wanted === null) throw fail('E_ARGS', '目标含非法字符');
  const state = load(dataDir, pluginId);
  const grants = Array.isArray(state.approvals) ? state.approvals : [];
  state.approvals = wanted
    ? grants.filter((entry) => !(entry.action === key && String(entry.target || '') === wanted))
    : grants.filter((entry) => entry.action !== key);
  save(dataDir, pluginId, state);
}

/**
 * 卸载时清空某个插件的授权、配额、写审计与待批请求。
 * 卸载不能只挪代码目录：enabledIds/开关、对象级批准、旧的 pending 都属于这个安装实例，
 * 重装同 id 的另一个包不能继承它们（2026-10 审查 P1）。
 */
export function clearPluginGrants(dataDir, pluginId) {
  try { fs.rmSync(grantsFile(dataDir, pluginId), { force: true }); } catch { /* 本来就不存在 */ }
  const pending = loadPending(dataDir);
  const kept = pending.filter((item) => item.pluginId !== pluginId);
  if (kept.length !== pending.length) savePending(dataDir, kept);
}

// ── 待批队列 ────────────────────────────────────────────────────────────

/**
 * 模型请求了一次未获批准的写操作：登记待批（同 插件+动作+目标 在有效期内只留一条）。
 * 返回带 id，控制台与私聊批准都用它。
 */
export function requestPendingApproval(dataDir, { pluginId, pluginName = '', action, label = '', target = '', preview = '', now = Date.now() } = {}) {
  const key = assertAction(action);
  const wanted = normalizeTarget(target);
  if (wanted === null) throw fail('E_ARGS', '待批目标含非法字符（不会生成通配批准）');
  const keyPreview = previewKey(preview);
  const list = loadPending(dataDir).filter((item) => Number(item.expiresAt) > now);
  // 同 (动作, 目标, 预览) 才去重：同目标换了评论正文时必须是一条新的待批，
  // 否则管理员看到的是旧文案、批准后却能发出新文案（2026-10-24 审查 P1）。
  const existing = list.find((item) => item.pluginId === pluginId && item.action === key
    && String(item.target || '') === wanted && String(item.previewKey || '') === keyPreview);
  if (existing) return { ...existing, duplicate: true };
  const entry = {
    id: `ap_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    pluginId,
    pluginName: String(pluginName).slice(0, 80),
    action: key,
    label: String(label).slice(0, 80),
    target: wanted,
    preview: String(preview).slice(0, 300),
    previewLength: String(preview).length,
    ...(keyPreview ? { previewKey: keyPreview } : {}),
    createdAt: now,
    expiresAt: now + PENDING_TTL_MS
  };
  savePending(dataDir, [...list, entry]);
  return { ...entry };
}

export function listPendingApprovals(dataDir, { now = Date.now() } = {}) {
  const list = loadPending(dataDir).filter((item) => Number(item.expiresAt) > now);
  if (list.length !== loadPending(dataDir).length) savePending(dataDir, list);
  return list;
}

/** 批准一条待批请求：生成对象级通行证并移出队列。返回通行证信息。 */
export function approvePendingApproval(dataDir, id, { uses = 1, ttlMs = 10 * 60_000, now = Date.now() } = {}) {
  if (!PENDING_ID_RE.test(String(id || ''))) throw fail('E_ARGS', '待批 id 不合法');
  const list = listPendingApprovals(dataDir, { now });
  const hit = list.find((item) => item.id === id);
  if (!hit) throw fail('E_NOT_FOUND', '这条待批请求不存在或已过期');
  // 先写通行证、再从待批队列移除：反过来的话两步之间崩溃会让管理员"批准了但没生效"
  //（2026-10-24 审查 P2）。失败时待批仍在，可以重试。
  const grant = grantApproval(dataDir, hit.pluginId, hit.action, {
    uses, ttlMs, target: hit.target, previewKey: hit.previewKey, now
  });
  savePending(dataDir, list.filter((item) => item !== hit));
  return { pending: hit, grant };
}

export function rejectPendingApproval(dataDir, id) {
  if (!PENDING_ID_RE.test(String(id || ''))) throw fail('E_ARGS', '待批 id 不合法');
  const list = listPendingApprovals(dataDir);
  const hit = list.find((item) => item.id === id);
  if (!hit) throw fail('E_NOT_FOUND', '这条待批请求不存在或已过期');
  savePending(dataDir, list.filter((item) => item !== hit));
  return hit;
}

// ── 写审计 ─────────────────────────────────────────────────────────────

/** 记一条写操作审计（控制台"日志"页签的数据源；宿主侧写，不信插件自报）。 */
export function recordPluginWrite(dataDir, pluginId, { action, target, outcome, note = '', now = Date.now() } = {}) {
  const key = assertAction(action);
  const state = load(dataDir, pluginId);
  const writes = Array.isArray(state.writes) ? state.writes : [];
  writes.unshift({
    at: now,
    action: key,
    target: normalizeTarget(target) ?? '',
    outcome: ['ok', 'failed', 'denied', 'pending', 'unknown'].includes(outcome) ? outcome : 'unknown',
    note: String(note).slice(0, 200)
  });
  state.writes = writes.slice(0, MAX_WRITES_KEPT);
  save(dataDir, pluginId, state);
  return state.writes[0];
}

export function listPluginWrites(dataDir, pluginId, limit = 30) {
  const state = load(dataDir, pluginId);
  return (Array.isArray(state.writes) ? state.writes : []).slice(0, Math.max(1, Math.min(100, Number(limit) || 30)));
}

// ── 配额 ───────────────────────────────────────────────────────────────

/**
 * 消费一次每日配额。没在 manifest.quotas 里声明的动作一律拒绝（fail-closed）。
 * 返回带 receipt：写"确定未执行"时退回当天额度。
 */
export function consumeQuota(dataDir, pluginId, action, limit, { amount = 1, now = Date.now() } = {}) {
  const key = assertAction(action);
  const max = Math.floor(Number(limit) || 0);
  if (max <= 0) {
    return { ok: false, used: 0, limit: 0, remaining: 0, day: dayKey(now), reason: '这个动作没有配置配额（不能在未声明配额的情况下调用）' };
  }
  const count = Math.max(1, Math.floor(Number(amount) || 1));
  const state = load(dataDir, pluginId);
  const day = dayKey(now);
  // 只保留当天：旧日期直接丢掉，文件不会无限长
  const quota = state.quota && state.quota.day === day ? state.quota : { day, counts: {} };
  quota.counts = quota.counts && typeof quota.counts === 'object' ? quota.counts : {};
  const used = Number(quota.counts[key]) || 0;
  if (used + count > max) {
    state.quota = quota;
    save(dataDir, pluginId, state);
    return { ok: false, used, limit: max, remaining: Math.max(0, max - used), day, reason: `今天的配额已用完（${used}/${max}）` };
  }
  quota.counts[key] = used + count;
  state.quota = quota;
  save(dataDir, pluginId, state);
  return {
    ok: true, used: used + count, limit: max, remaining: Math.max(0, max - used - count), day, reason: '',
    receipt: { pluginId, action: key, day, amount: count, refunded: false }
  };
}

/** 退还一次配额（与 refundApproval 同口径：确定未执行才退，幂等）。 */
export function refundQuota(dataDir, pluginId, receipt) {
  if (!receipt || receipt.refunded === true || !receipt.action || !receipt.day) return false;
  const state = load(dataDir, pluginId);
  if (state.quota && state.quota.day === receipt.day) {
    const counts = state.quota.counts || {};
    counts[receipt.action] = Math.max(0, (Number(counts[receipt.action]) || 0) - (Number(receipt.amount) || 1));
    state.quota.counts = counts;
    save(dataDir, pluginId, state);
  }
  receipt.refunded = true;
  return true;
}

/** 控制台展示：当前授权（含目标）、待批不走这里（全局队列）、今日配额。 */
export function grantsStatus(dataDir, pluginId, { approvals = [], quotas = {}, now = Date.now() } = {}) {
  const state = load(dataDir, pluginId);
  const grants = cleanGrants({ approvals: state.approvals }, now);
  const current = {};
  for (const item of approvals) {
    const hit = grants
      .filter((entry) => entry.action === item.action && Number(entry.usesLeft) > 0)
      .reduce((sum, entry) => ({
        expiresAt: Math.max(sum.expiresAt, Number(entry.expiresAt) || 0),
        usesLeft: sum.usesLeft + (Number(entry.usesLeft) || 0),
        targets: [...sum.targets, ...(String(entry.target || '') ? [String(entry.target)] : [])]
      }), { expiresAt: 0, usesLeft: 0, targets: [] });
    if (hit.usesLeft > 0) current[item.action] = hit;
  }
  const day = dayKey(now);
  const counts = state.quota?.day === day ? (state.quota.counts || {}) : {};
  return {
    approvals: current,
    quota: Object.fromEntries(Object.entries(quotas).map(([action, limit]) => [action, {
      used: Number(counts[action]) || 0,
      limit
    }]))
  };
}
