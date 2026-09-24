// 超大图片兜底（Issue #6）：群友发 >12MiB 的图时，常规拉取直接失败，
// 视觉模型什么都看不到。这里放宽上限取回全量，再用系统 ffmpeg 降采样到
// 2048px JPEG 交给视觉模型（实测 48MB PNG → 3.6MB JPEG）。
// ffmpeg 是可选能力：缺失或失败时抛出带指引的错误，绝不影响常规 ≤12MiB 路径。
import { spawn } from 'node:child_process';
import { safeFetchBinary } from '../llm/safe-fetch.js';

// safe-fetch.js readBounded 的超限报错形态（"响应体超过 N 字节限制"）。
// 用报错形态识别"是不是拉超了"，其他错误（HTTP 4xx/5xx、SSRF 拦截）原样上抛。
export const OVERSIZE_LIMIT_RE = /响应体超过\s*\d+\s*字节限制/;

const PROBE_TTL_MS = 10 * 60 * 1000;
let probeCache = { at: 0, path: null };

/** 探测系统 ffmpeg（进程内缓存，含失败结果；失败 10 分钟后允许重探一次）。 */
export async function resolveFfmpeg() {
  const cached = probeCache.path;
  if (cached && Date.now() - probeCache.at < PROBE_TTL_MS) return cached;
  if (!cached && Date.now() - probeCache.at < PROBE_TTL_MS) return null;
  probeCache.at = Date.now();
  probeCache.path = await new Promise((resolve) => {
    let child;
    try {
      child = spawn('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 5000);
    timer.unref?.();
    child.on('error', () => resolve(null));
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? 'ffmpeg' : null); });
  });
  return probeCache.path;
}

function runFfmpeg(ffmpegPath, buffer, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vf', "scale='min(2048,iw)':-2",
      '-frames:v', '1',
      '-q:v', '5',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1'
    ], { windowsHide: true });
    const chunks = [];
    let stderr = '';
    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      fn(value);
    };
    timer = setTimeout(() => settle(reject, new Error('ffmpeg 降采样超时（30 秒）')), 30000);
    timer.unref?.();
    signal?.addEventListener('abort', () => settle(reject, new Error('已中止')), { once: true });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 4000) stderr = stderr.slice(0, 4000);
    });
    child.stdin.on('error', () => { /* EPIPE 时以 close/error 为准 */ });
    child.on('error', (error) => settle(reject, new Error(`ffmpeg 启动失败：${error.message}`)));
    child.on('close', (code) => {
      const out = Buffer.concat(chunks);
      if (code === 0 && out.length) settle(resolve, out);
      else settle(reject, new Error(`ffmpeg 降采样失败（exit ${code}）：${stderr.trim().split('\n').pop() || '无错误输出'}`));
    });
    child.stdin.end(buffer);
  });
}

/**
 * 常规上限拉取抛出"超限"时调用：放宽到 largeCap 重拉一次，确认拿到的确实是
 * 图片（content-type image/*）后交给 ffmpeg 降采样成 JPEG。
 * 拿不到图 / 二次拉取失败 → 把原始超限错误抛回去（贴近真相）；
 * ffmpeg 缺失 → 抛带安装指引的错误；降采样失败 → 抛 ffmpeg 的具体错误。
 */
export async function fetchOversizedImageAsJpeg(safeUrl, originalError, signal, {
  cap = 12 * 1024 * 1024,
  largeCap = 96 * 1024 * 1024
} = {}) {
  if (!OVERSIZE_LIMIT_RE.test(String(originalError?.message ?? ''))) throw originalError;
  const ffmpegPath = await resolveFfmpeg();
  if (!ffmpegPath) {
    throw new Error(`${originalError.message}；图片超过 ${Math.round(cap / 1024 / 1024)} MiB 且系统未安装 ffmpeg，无法自动降采样（安装 ffmpeg 后即可支持超大图）`);
  }
  let buffer;
  let contentType;
  try {
    ({ buffer, contentType } = await safeFetchBinary(safeUrl, largeCap, signal));
  } catch {
    throw originalError; // 二次拉取失败：原始超限错误更贴近真相
  }
  if (!buffer?.length || !/^image\//i.test(String(contentType || ''))) throw originalError;
  const jpeg = await runFfmpeg(ffmpegPath, buffer, signal);
  return { buffer: jpeg, contentType: 'image/jpeg' };
}
