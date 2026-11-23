// Breeze 语音合成（BreezeBlue 云端 / 本机自建）。
// 云端模式（默认）：
//   POST {baseUrl}/v1/text-to-speech/{voiceId}?output_format=mp3_24000_128&delivery=sync
//   请求头：xi-api-key: <key>
//   请求体：{ text, model_id, language_code? }
// 本地自建模式（mode === 'local'）：
//   POST {baseUrl}/v1/audio/speech（multipart 表单 text / instruction / cfg_scale）
import fs from 'node:fs';
import path from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { watchTimeWindow } from '../core/time-gate.js';
import { readBytesBounded, readTextBounded } from '../core/http-body.js';
import { DATA_DIR } from '../core/config.js';

export const BREEZE_DEFAULT_URL = 'https://api.breeze.blue';
export const BREEZE_DEFAULT_SITE = 'https://breezeblue.ai';
export const BREEZE_DEFAULT_MODEL = 'breeze-tts-2';
export const BREEZE_DEFAULT_VOICE = 'voc_8yud7hz7c9q2';
export const BREEZE_DEFAULT_FORMAT = 'mp3_24000_128';
const MAX_TEXT_CHARS = 300;

// 同一天不重复领：留 20 小时，跨天时因为时区/停机也能补上
const CLAIM_GAP_MS = 20 * 3600 * 1000;

const accountFile = () => path.join(DATA_DIR, 'breeze-account.json');

function readAccountRaw() {
  try {
    const j = JSON.parse(fs.readFileSync(accountFile(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** 账号配置（不含密码）：给面板显示用。 */
export function breezeAccountView() {
  const a = readAccountRaw();
  return {
    email: String(a.email || ''),
    autoClaim: a.autoClaim !== false,
    hasPassword: Boolean(String(a.password || '')),
    lastClaimAt: Number(a.lastClaimAt) || 0,
    lastTier: String(a.lastTier || ''),
    lastClaimMsg: String(a.lastClaimMsg || '')
  };
}

/**
 * 保存账号配置（email / password / autoClaim）。
 * 密码：留空或 ****** = 保持不变（与其它密钥字段同语义）。
 */
export function saveBreezeAccount({ email, password, autoClaim } = {}) {
  const cur = readAccountRaw();
  if (email !== undefined) cur.email = String(email || '').trim();
  if (autoClaim !== undefined) cur.autoClaim = Boolean(autoClaim);
  const pw = String(password ?? '').trim();
  if (pw && pw !== '******') cur.password = pw;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(accountFile(), JSON.stringify(cur), { mode: 0o600 });
    try { fs.chmodSync(accountFile(), 0o600); } catch { /* 已存在时补收权限 */ }
  } catch (error) {
    throw new Error(`保存 Breeze 账号失败：${error?.message ?? error}`);
  }
  return breezeAccountView();
}

const siteOf = (c) => String(c?.siteUrl || BREEZE_DEFAULT_SITE).replace(/\/+$/, '');
const baseOf = (c) => String(c?.baseUrl || c?.url || BREEZE_DEFAULT_URL).replace(/\/+$/, '');
const timeoutOf = (c) => Number(c?.timeoutMs) || 20000;
// 站点接口有 Origin 校验（不带就 403），而 Node fetch 不允许设 origin 头，所以走 node:https 手发
const siteHeaders = (c, extra = {}) => ({ origin: siteOf(c), referer: siteOf(c) + '/app/studio', ...extra });

function siteRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch { reject(new Error('站点地址不对：' + url)); return; }
    const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = send(target, {
      method,
      headers: { accept: 'application/json', ...headers, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = JSON.parse(text); } catch { json = {}; }
        const cookies = (res.headers['set-cookie'] || []).map((v) => String(v).split(';')[0].trim()).filter(Boolean);
        resolve({ status: res.statusCode || 0, headers: res.headers, text, json, cookies });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`站点请求超时（${timeoutMs}ms）`)));
    req.on('error', (error) => reject(new Error(`连不上站点：${error.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 查余额（不抛异常）：GET {baseUrl}/v1/balance 带 xi-api-key。
 * @returns {Promise<{ok:boolean, hasKey:boolean, balance:number|null, note:string}>}
 */
export async function breezeBalance({ baseUrl, apiKey, timeoutMs = 15000 } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, hasKey: false, balance: null, note: '没填 API Key' };
  try {
    const r = await fetch(`${baseOf({ baseUrl })}/v1/balance`, {
      headers: { 'xi-api-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(3000, Number(timeoutMs) || 15000))
    });
    if (r.status === 401) return { ok: false, hasKey: true, balance: null, note: 'API Key 不对或已撤销' };
    if (!r.ok) return { ok: false, hasKey: true, balance: null, note: `HTTP ${r.status}` };
    const j = await r.json().catch(() => ({}));
    const raw = j.balance ?? j.credits ?? j.remaining ?? j?.data?.balance ?? j?.data?.credits;
    const n = Number(raw);
    return { ok: true, hasKey: true, balance: Number.isFinite(n) ? n : null, note: '' };
  } catch (error) {
    return { ok: false, hasKey: true, balance: null, note: `连不上：${error.message}` };
  }
}

/** 登录：邮箱密码换会话 Cookie，写回账号文件。 */
async function breezeLogin(account) {
  const email = String(account?.email || '').trim();
  const password = String(account?.password || '');
  if (!email || !password) throw new Error('还没填 Breeze 账号邮箱/密码');
  const r = await siteRequest(`${siteOf(account)}/api/auth/email/continue`, {
    method: 'POST',
    headers: siteHeaders(account, { 'content-type': 'application/json' }),
    body: { email, password },
    timeoutMs: timeoutOf(account)
  });
  if (r.status !== 200) {
    const detail = (r.json?.detail || r.text || '').slice(0, 120);
    const hint = r.status === 403 ? '（Origin 被拒）' : r.status === 422 ? '（密码不对，或新账号要求至少 8 位）' : '';
    throw new Error(`Breeze 登录失败 HTTP ${r.status}${hint}：${detail}`);
  }
  if (!r.cookies.length) throw new Error('Breeze 登录没拿到会话 Cookie');
  const cookie = r.cookies.join('; ');
  const cur = readAccountRaw();
  cur.cookie = cookie;
  try { fs.writeFileSync(accountFile(), JSON.stringify(cur), { mode: 0o600 }); } catch { /* 忽略 */ }
  return cookie;
}

/**
 * 领今天的额度。Cookie 失效会重登一次；discord 档被拒自动降级 standard（+100）。
 * @returns {Promise<{ok:boolean, already:boolean, tier:string, reward:number|null, balance:number|null, message:string}>}
 */
export async function breezeClaim(account = {}, { log } = {}) {
  const email = String(account?.email || '').trim();
  if (!email || !account?.password) throw new Error('还没填 Breeze 账号邮箱/密码');

  let cur = readAccountRaw();
  let sessionCookie = String(cur.cookie || '');
  const send = async (which) => {
    if (!sessionCookie) sessionCookie = await breezeLogin(account);
    return siteRequest(`${siteOf(account)}/api/credits/daily-claim`, {
      method: 'POST',
      headers: siteHeaders(account, { 'content-type': 'application/json', cookie: sessionCookie }),
      body: { reward_tier: which },
      timeoutMs: timeoutOf(account)
    });
  };

  let used = 'discord';
  let out = await send(used);
  if (out.status === 401) {           // 会话过期：重登一次再试
    sessionCookie = await breezeLogin(account);
    out = await send(used);
  }
  const already = (x) => x.status === 409 || x.json?.already_claimed === true || /already|claimed/i.test(String(x.text || ''));
  // discord 档要绑 Discord：失败且不是「今天领过了」就降级 standard（+100）
  if (out.status !== 200 && used !== 'standard' && !already(out)) {
    used = 'standard';
    out = await send(used);
  }
  const { status, json: j, text } = out;
  const ok = status === 200 || already(out);
  if (!ok) throw new Error(`Breeze 领取额度失败 HTTP ${status}：${String(text || JSON.stringify(j)).slice(0, 140)}`);
  const reward = Number(j.credits_issued ?? j.reward ?? j.amount ?? j?.data?.reward ?? j?.data?.amount);
  const balance = Number(j.balance ?? j?.data?.balance);
  const msg = j.claimed === true
    ? `领到 ${Number.isFinite(reward) ? reward : '?'} 额度` + (Number.isFinite(balance) ? `，当前 ${balance}` : '')
    : already(out)
      ? '今天已经领过了' + (Number.isFinite(balance) ? `（当前 ${balance}）` : '')
      : (j.message || j.note || '领完了');

  cur = { ...readAccountRaw(), email, lastClaimAt: Date.now(), lastTier: used, lastClaimMsg: msg };
  try { fs.writeFileSync(accountFile(), JSON.stringify(cur), { mode: 0o600 }); } catch { /* 忽略 */ }
  log?.info?.(`Breeze 领取额度（${used}）：${msg}`);
  return {
    ok: true,
    claimed: j.claimed === true,
    already: already(out),
    tier: used,
    reward: Number.isFinite(reward) ? reward : null,
    balance: Number.isFinite(balance) ? balance : null,
    message: msg
  };
}

/** 到点该不该自动领：开了自动领取、填了账号、距离上次够久。 */
export function shouldAutoClaim(now = Date.now()) {
  const a = readAccountRaw();
  if (a.autoClaim === false) return false;
  if (!String(a.email || '').trim() || !a.password) return false;
  const last = Number(a.lastClaimAt) || 0;
  return now - last >= CLAIM_GAP_MS;
}

/** 一次自动领取：失败只记日志，不抛（定时任务里用）。 */
export async function autoClaimOnce({ log } = {}) {
  if (!shouldAutoClaim()) return { ok: false, skipped: true };
  try {
    const a = readAccountRaw();
    const r = await breezeClaim({ email: a.email, password: a.password }, { log });
    return { ok: true, ...r };
  } catch (error) {
    log?.warn?.(`Breeze 自动领取额度失败：${error.message}`);
    return { ok: false, message: error.message };
  }
}

/** 用已保存的账号领今天的额度（面板按钮用）。 */
export async function breezeClaimSaved({ log } = {}) {
  const a = readAccountRaw();
  const email = String(a.email || '').trim();
  if (!email || !a.password) throw new Error('还没填 Breeze 账号邮箱/密码');
  return breezeClaim({ email, password: a.password }, { log });
}

export const BREEZE_CLAIM_GAP_MS = CLAIM_GAP_MS;


/**
 * Breeze 语音合成入口。
 * cfg: { baseUrl, apiKey, voice/voiceId, model, outputFormat/format, mode, instructions, guidanceScale, languageCode, timeoutMs }
 */
export async function synthesizeBreeze({
  cfg,
  text,
  signal = null,
  fetchFn = fetch
} = {}) {
  const base = String(cfg?.baseUrl || BREEZE_DEFAULT_URL).trim().replace(/\/+$/, '') || BREEZE_DEFAULT_URL;
  const body = String(text || '').trim().slice(0, MAX_TEXT_CHARS);
  if (!body) throw new Error('要合成的文本为空');

  const mode = String(cfg?.mode || 'cloud').trim().toLowerCase();
  if (mode === 'local') {
    return synthesizeBreezeLocal({ cfg, base, body, signal, fetchFn });
  }

  const key = String(cfg?.apiKey || '').trim();
  const voiceId = String(cfg?.voice || cfg?.voiceId || '').trim();
  if (!key) throw new Error('Breeze 没填 API Key（brz_ 开头）');
  if (!voiceId) throw new Error('Breeze 没填音色 id（voc_ 开头）');

  const model = String(cfg?.model || BREEZE_DEFAULT_MODEL).trim() || BREEZE_DEFAULT_MODEL;
  const format = String(cfg?.outputFormat || cfg?.format || BREEZE_DEFAULT_FORMAT).trim() || BREEZE_DEFAULT_FORMAT;

  const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}&delivery=sync`;
  const reqBody = { text: body, model_id: model };
  if (cfg?.languageCode || cfg?.language) {
    reqBody.language_code = String(cfg.languageCode || cfg.language).trim();
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(cfg?.timeoutMs) || 30000);
  const timer = setTimeout(() => controller.abort(new Error('语音合成超时')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('Run cancelled'));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const releaseTimeGuard = watchTimeWindow((error) => controller.abort(error));

  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'accept': 'application/json, audio/*',
        'content-type': 'application/json'
      },
      body: JSON.stringify(reqBody),
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(`Breeze 连不上（${base}）：${error.message}`);
  } finally {
    clearTimeout(timer);
    releaseTimeGuard();
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = String(await readTextBounded(res, 4096)).slice(0, 160); } catch { /* 忽略 */ }
    const hint = res.status === 401 ? '：Key 不对或已撤销'
      : res.status === 402 ? '：额度不够'
      : res.status === 429 ? '：撞频率限制了'
      : '';
    throw new Error(`Breeze HTTP ${res.status}${hint}：${detail}`);
  }

  const type = res.headers?.get?.('content-type') || '';
  if (type && !/^(audio\/|application\/octet-stream)/i.test(type)) {
    let detail = '';
    try { detail = String(await readTextBounded(res, 4096)).slice(0, 160); } catch { /* 忽略 */ }
    throw new Error(`Breeze 没返回音频（content-type=${type}）：${detail}`);
  }

  let buffer;
  try {
    buffer = await readBytesBounded(res, 4 * 1024 * 1024);
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') throw new Error('语音合成结果过大（>4MB）');
    throw error;
  }

  if (buffer.length < 400) throw new Error('Breeze 返回的音频太短：' + buffer.length + ' 字节');
  return { buffer, format: 'mp3' };
}

/**
 * 本机 breeze_infer 服务（POST /v1/audio/speech，multipart 表单）。
 */
async function synthesizeBreezeLocal({ cfg, base, body, signal, fetchFn }) {
  if (!base) throw new Error('没填 Breeze 本地服务地址');

  const form = new FormData();
  form.set('text', body);
  if (cfg?.instructions) form.set('instruction', String(cfg.instructions));
  const cfgScale = Number(cfg?.guidanceScale);
  if (Number.isFinite(cfgScale) && cfgScale > 0) form.set('cfg_scale', String(cfgScale));

  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(cfg?.timeoutMs) || 60000);
  const timer = setTimeout(() => controller.abort(new Error('语音合成超时')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('Run cancelled'));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const releaseTimeGuard = watchTimeWindow((error) => controller.abort(error));

  let res;
  try {
    res = await fetchFn(`${base}/v1/audio/speech`, {
      method: 'POST',
      body: form,
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(`Breeze 本地服务连不上（${base}）：${error.message}`);
  } finally {
    clearTimeout(timer);
    releaseTimeGuard();
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = String(await readTextBounded(res, 4096)).slice(0, 160); } catch { /* 忽略 */ }
    const hint = res.status === 409 ? '：本地正在合成上一句，等它说完再试' : '';
    throw new Error(`Breeze 本地 HTTP ${res.status}${hint}：${detail}`);
  }

  const type = res.headers?.get?.('content-type') || '';
  if (type && !/^(audio\/|application\/octet-stream)/i.test(type)) {
    let detail = '';
    try { detail = String(await readTextBounded(res, 4096)).slice(0, 160); } catch { /* 忽略 */ }
    throw new Error(`Breeze 本地没返回音频（content-type=${type}）：${detail}`);
  }

  let buffer;
  try {
    buffer = await readBytesBounded(res, 4 * 1024 * 1024);
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') throw new Error('语音合成结果过大（>4MB）');
    throw error;
  }

  if (buffer.length < 400) throw new Error('Breeze 本地返回的音频太短：' + buffer.length + ' 字节');
  const isWav = buffer.toString('ascii', 0, 4) === 'RIFF';
  const format = isWav ? 'wav' : 'mp3';
  return { buffer, format };
}

/**
 * 列出云端音色。
 * GET {baseUrl}/v1/voices 带 xi-api-key。
 */
export async function breezeVoices({
  baseUrl = BREEZE_DEFAULT_URL,
  apiKey = '',
  timeoutMs = 15000,
  signal = null,
  fetchFn = fetch
} = {}) {
  const base = String(baseUrl || BREEZE_DEFAULT_URL).trim().replace(/\/+$/, '') || BREEZE_DEFAULT_URL;
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, message: '还没填 API Key' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), Math.max(3000, Number(timeoutMs) || 15000));
  const onAbort = () => controller.abort(signal?.reason ?? new Error('Run cancelled'));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetchFn(`${base}/v1/voices`, {
      method: 'GET',
      headers: { 'xi-api-key': key, accept: 'application/json' },
      signal: controller.signal
    });
    if (res.status === 401) return { ok: false, message: 'API Key 不对或已撤销' };
    if (!res.ok) return { ok: false, message: `Breeze 返回 HTTP ${res.status}` };
    const text = await readTextBounded(res, 1024 * 1024);
    let j = {};
    try { j = JSON.parse(text); } catch { j = {}; }
    const raw = j.voices || j.data || j.items || (Array.isArray(j) ? j : []);
    const voices = raw
      .map((v) => ({
        id: String(v?.voice_id || v?.voiceId || v?.id || ''),
        label: String(v?.name || v?.title || v?.voice_id || ''),
        cat: String(v?.origin || v?.voice_type || 'Breeze')
      }))
      .filter((v) => v.id);
    return { ok: true, voices };
  } catch (error) {
    return { ok: false, message: `连不上 Breeze：${error.message}` };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
