// generate_image 工具执行与图生图参考图收口（从 tools-core.js 拆出守行数基线）。
import { getConfig, imageGenAvailable, imageGenMaxPerHour } from '../core/config.js';
import { imageType } from '../core/image-type.js';
import { sanitizeUserText, unquoteJsonString } from '../core/util.js';
import { generateImage, MAX_PROMPT_CHARS } from '../llm/image-gen.js';
import { resolveApiKey } from '../llm/llm.js';
import { safeFetchBinary, validateImageUrl } from '../llm/safe-fetch.js';
import { fetchOversizedImageAsJpeg, prepareReferenceImageDataUrl } from './image-downsample.js';
import { midHint, visibleEntry } from './message-visibility.js';

const MAX_LOCAL_REF_BYTES = 12 * 1024 * 1024;

/** 拉取参考图并收口为适合图生图接口（data:image/…;base64,…）的 data URI。 */
export async function downloadReferenceImageAsDataUrl(url, signal) {
  signal?.throwIfAborted();
  if (String(url || '').startsWith('base64://')) {
    const buffer = Buffer.from(String(url).slice('base64://'.length), 'base64');
    if (!buffer.length || buffer.length > MAX_LOCAL_REF_BYTES) {
      throw new Error('本地参考图片为空或超过 12 MiB');
    }
    const mime = imageType(buffer);
    if (!mime) throw new Error('本地参考图片格式无效');
    return prepareReferenceImageDataUrl(buffer, mime, signal);
  }
  const safeUrl = await validateImageUrl(url);
  let buffer;
  let contentType;
  try {
    ({ buffer, contentType } = await safeFetchBinary(safeUrl, MAX_LOCAL_REF_BYTES, signal));
  } catch (error) {
    ({ buffer, contentType } = await fetchOversizedImageAsJpeg(safeUrl, error, signal, { gifSingleFrame: true }));
  }
  if (!buffer || !buffer.length) throw new Error('参考图片内容为空');
  const mime = imageType(buffer) || String(contentType || 'image/jpeg').split(';')[0];
  return prepareReferenceImageDataUrl(buffer, mime, signal);
}

/** 从消息或表情库解析图生图参考图；失败返回 { error, reportIncident? }。 */
async function resolveReferenceImage(ctx, args, { currentMessageImageUrls, stickerLookupHint, normalizeMid }) {
  const hasMsg = args.sourceMessageId !== undefined && args.sourceMessageId !== null && String(args.sourceMessageId).trim() !== '';
  const hasSticker = args.sourceStickerId !== undefined && args.sourceStickerId !== null && String(args.sourceStickerId).trim() !== '';
  if (hasMsg && hasSticker) {
    return { error: 'sourceMessageId 和 sourceStickerId 只能传一个，不能同时指定' };
  }
  if (!hasMsg && !hasSticker) return { image: '' };

  if (hasMsg) {
    const rawMid = String(args.sourceMessageId).trim();
    const entry = visibleEntry(ctx, normalizeMid(rawMid)) || visibleEntry(ctx, rawMid);
    if (!entry) return { error: `当前会话找不到消息 ${args.sourceMessageId}。${midHint(ctx)}` };
    let viewables = await currentMessageImageUrls(ctx, entry);
    let images = viewables.filter((item) => item.kind === 'image');
    // 模型常把引用回复那条消息的 #id 当成参考图来源：本条没图时顺着引用回退一跳。
    if (!images.length && entry.reply?.messageId) {
      const replyEntry = visibleEntry(ctx, entry.reply.messageId);
      if (replyEntry) {
        const replyViewables = await currentMessageImageUrls(ctx, replyEntry);
        const replyImages = replyViewables.filter((item) => item.kind === 'image');
        if (replyImages.length) {
          images = replyImages;
          viewables = replyViewables;
        }
      }
    }
    if (!images.length) {
      if (viewables.some((item) => item.kind === 'video')) {
        return { error: `消息 ${args.sourceMessageId} 里只有视频，没有可作图生图参考的静态图片` };
      }
      return { error: `消息 ${args.sourceMessageId} 里没有可作参考的图片` };
    }
    const rawIndex = args.imageIndex;
    const imageIndex = (rawIndex === undefined || rawIndex === null || rawIndex === '') ? 1 : Number(rawIndex);
    if (!Number.isInteger(imageIndex) || imageIndex < 1 || imageIndex > images.length) {
      return { error: `消息 ${args.sourceMessageId} 共有 ${images.length} 张图片，imageIndex 请传 1~${images.length}` };
    }
    const image = await downloadReferenceImageAsDataUrl(images[imageIndex - 1].url, ctx.signal);
    return { image };
  }

  const stickerKey = unquoteJsonString(String(args.sourceStickerId).trim());
  let sticker = null;
  try {
    sticker = await ctx.stickers.findForSend(stickerKey);
  } catch (error) {
    if (error?.code === 'STICKER_LINK_DEAD') {
      return { error: `${error.message}。换一张，或用 list_stickers 看看别的。` };
    }
    throw error;
  }
  if (!sticker) {
    return { error: `找不到表情。${await stickerLookupHint(ctx, stickerKey)}`, reportIncident: false };
  }
  if (!sticker.url) return { error: `表情 ${sticker.id} 没有可用的图片地址` };
  const image = await downloadReferenceImageAsDataUrl(sticker.url, ctx.signal);
  return { image };
}

/** 执行 generate_image（文生图 / 图生图共用闸门、落库与发送链路）。 */
export async function executeGenerateImage(ctx, args, {
  currentMessageImageUrls,
  stickerLookupHint,
  imageQuota,
  normalizeMid,
  afterSent,
  ok,
  err
}) {
  try {
    const cfg = getConfig();
    if (!imageGenAvailable(cfg)) return err('图片生成未启用或未配置（设置 → 图片生成）');
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return err('prompt 不能为空');
    if (prompt.length > MAX_PROMPT_CHARS) return err(`画面描述太长了（≤${MAX_PROMPT_CHARS} 字），说短一点`);

    // 参考图解析与下载在扣费闸门之前完成：找不到消息/链接失效/下载失败不白占每小时额度。
    const ref = await resolveReferenceImage(ctx, args, { currentMessageImageUrls, stickerLookupHint, normalizeMid });
    if (ref.error) {
      return err(ref.error, ref.reportIncident === false ? { reportIncident: false } : {});
    }
    const referenceImage = ref.image;

    // 按张计费：**事前原子消费**再生成 —— 这是唯一一道成本闸门，并发下必须封顶。
    // 每次读配置：界面上改上限后不必重启就生效
    imageQuota.configure({ globalMax: imageGenMaxPerHour(cfg), perChatMax: Infinity });
    const reservedAt = Date.now();
    const gate = imageQuota.tryConsume(ctx.chatKey, reservedAt);
    if (!gate.ok) {
      return err(gate.scope === 'chat'
        ? '本会话的画图额度用完了（每小时有上限），过一会儿再画'
        : '画图额度用完了（全局每小时有上限，这是按张计费的）');
    }
    let buffer;
    let revisedPrompt;
    const label = String(args.note || '').trim() || prompt;
    let entry;
    try {
      ({ buffer, revisedPrompt } = await generateImage({
        cfg,
        apiCfg: cfg.api,
        apiKey: resolveApiKey(cfg),
        prompt,
        image: referenceImage,
        signal: ctx.signal
      }));
      // 落库：走与"控制台上传的自定义表情"同一条路（addManual 自己校验格式与体积并落盘）
      entry = ctx.stickers.addManual({
        imageBuffer: buffer,
        desc: label.slice(0, 40),
        localNote: `${referenceImage ? '图生图' : '生成的图'}：${prompt}`.slice(0, 300),
        tags: referenceImage ? ['生成', '图生图'] : ['生成'],
        usage: revisedPrompt ? `提示词修订：${revisedPrompt}`.slice(0, 300) : ''
      });
    } catch (error) {
      // 生成已经发出去了（中止/超时/落库失败）就不能退额度：服务商侧可能已完成并计费。
      // 只有"请求根本没发出去"的配置/参数错误才退。
      const maybeBilled = Boolean(buffer) || ctx.signal?.aborted === true
        || /超时|timeout|abort|cancel|ECONN|ETIMEDOUT|落库|addManual/i.test(String(error?.message ?? error));
      if (!maybeBilled) imageQuota.refund(ctx.chatKey, reservedAt);
      throw error;
    }

    const autoSend = args.send !== false && cfg.imageGen?.autoSend !== false;
    if (!autoSend) {
      return ok({
        id: entry.id,
        note: entry.localNote,
        sent: false,
        ...(referenceImage ? { mode: 'img2img' } : {}),
        kind: '已存进表情库（未发送）',
        next: '需要发送时用 send_sticker 传这个 id'
      });
    }
    try {
      const sendable = await ctx.stickers.findForSend(entry.id);
      if (!sendable?.url) throw new Error('生成的图片没有可发送的地址');
      const sendAsImage = cfg.imageGen?.sendAs === 'image';
      const sent = sendAsImage
        ? await ctx.sender.sendImage(ctx.chatKey, sendable, { runId: ctx.session.leaseId, signal: ctx.signal })
        : await ctx.sender.sendSticker(ctx.chatKey, sendable, { runId: ctx.session.leaseId, signal: ctx.signal });
      afterSent(() => {
        ctx.stickers.markUsed(entry.id, String(ctx.session.triggerText || '').slice(0, 100));
        ctx.session.sent.push({
          type: sendAsImage ? 'image' : 'sticker',
          text: `[${referenceImage ? '图生图' : '生成的图'}:${sanitizeUserText(label.slice(0, 40))}]`,
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        });
        ctx.emit('session-update', ctx.session.id);
      });
      return ok({
        id: entry.id,
        note: entry.localNote,
        sent: true,
        messageId: sent?.message_id ?? null,
        ...(referenceImage ? { mode: 'img2img' } : {}),
        kind: '已发送并存入表情库'
      });
    } catch (error) {
      return ok({
        id: entry.id,
        note: entry.localNote,
        sent: false,
        ...(referenceImage ? { mode: 'img2img' } : {}),
        kind: '已生成并存入表情库，但发送失败',
        warning: `发送失败：${error?.message ?? error}。不要重复生成；结果不确定时不要自动重发。`
      });
    }
  } catch (error) {
    return err(error?.message ?? error);
  }
}
