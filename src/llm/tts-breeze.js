// Breeze 语音合成（BreezeBlue 云端 / 本机自建）。
// 云端模式（默认）：
//   POST {baseUrl}/v1/text-to-speech/{voiceId}?output_format=mp3_24000_128&delivery=sync
//   请求头：xi-api-key: <key>
//   请求体：{ text, model_id, language_code? }
// 本地自建模式（mode === 'local'）：
//   POST {baseUrl}/v1/audio/speech（multipart 表单 text / instruction / cfg_scale）
import { watchTimeWindow } from '../core/time-gate.js';
import { readBytesBounded, readTextBounded } from '../core/http-body.js';

export const BREEZE_DEFAULT_URL = 'https://api.breeze.blue';
export const BREEZE_DEFAULT_MODEL = 'breeze-tts-2';
export const BREEZE_DEFAULT_VOICE = 'voc_8yud7hz7c9q2';
export const BREEZE_DEFAULT_FORMAT = 'mp3_24000_128';
const MAX_TEXT_CHARS = 300;

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
