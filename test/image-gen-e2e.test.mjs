// generate_image 端到端：真落库（StickerManager + 真实数据目录）→ 能被 send_sticker 发出去。
// 这是"工具链真的通了"的证据 —— 只测适配器不够：落库失败、条目取不出来都是单测看不见的。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-imagegen-e2e-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } });

// 一张最小但**合法**的 PNG（1x1 透明像素）：StickerManager 会校验魔数
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active' },
  allow: { private: ['1'] },
  api: { baseUrl: 'https://gateway.example.com/v1', apiKey: 'model-key', model: 'm' },
  sticker: { enabled: true },
  imageGen: { enabled: true, model: 'gpt-image-1', baseUrl: '', maxPerHour: 1 }
}));

const { buildToolDefs, resetImageQuotaForTest } = await import('../src/tools/tools-core.js');
const { StickerManager } = await import('../src/onebot/sticker-manager.js');
const { imageGenAvailable, imageGenMaxPerHour } = await import('../src/core/config.js');

const tool = (name) => buildToolDefs().find((entry) => entry.name === name);
const MAX_PROMPT_CHARS = 800;

function context(patch = {}) {
  const manager = new StickerManager({});
  const sends = [];
  return {
    manager,
    sends,
    ctx: {
      kind: 'group',
      chatId: '1',
      chatKey: 'group:1',
      session: { id: 'session', leaseId: 'lease', sent: [], feedbacks: [] },
      sender: {
        sendSticker: async (...args) => { sends.push({ mode: 'sticker', args }); return { message_id: 7 }; },
        sendImage: async (...args) => { sends.push({ mode: 'image', args }); return { message_id: 8 }; }
      },
      stickers: manager,
      store: { activeMembers: () => [], recent: () => [], findByMid: () => null },
      onebot: {},
      emit: () => {},
      ...patch
    }
  };
}

test('端到端：拿到 b64_json → 真落库（addManual）→ 自动发到当前会话', async () => {
  // 用真实的 fetch 桩替换全局 fetch：工具内部直接调 generateImage（默认 fetchFn=fetch）
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, req) => {
    calls.push({ url: String(url), body: JSON.parse(req.body || '{}') });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })
    };
  };
  try {
    assert.equal(imageGenAvailable(), true);
    const f = context();
    const res = await tool('generate_image').execute(f.ctx, { prompt: '一只橘猫戴着草帽', note: '橘猫梗图' });
    assert.equal(res.isError, undefined, `生成失败：${res.content}`);

    // ① 请求形状：打到 /images/generations，复用模型 Key（地址留空 = 与模型同域）
    assert.equal(calls[0].url, 'https://gateway.example.com/v1/images/generations');
    assert.equal(calls[0].body.model, 'gpt-image-1');
    assert.equal(calls[0].body.prompt, '一只橘猫戴着草帽');

    // ② 落库：条目真的在库里，带本地文件与备注
    const saved = JSON.parse(res.content);
    assert.ok(saved.id, '返回里要有条目 id');
    const entry = f.manager.entries.find((e) => e.id === saved.id);
    assert.ok(entry, '条目要真的落进表情库');
    assert.equal(entry.source, 'manual');
    assert.ok(/^sticker-assets\/.+\.png$/.test(entry.localFile));
    assert.ok(entry.localNote.includes('一只橘猫戴着草帽'), 'localNote 要记下提示词，便于 list_stickers 认');
    assert.ok(fs.existsSync(path.join(dataDir, entry.localFile)), '图片文件要真的落盘');

    // ③ 自动发送：不等模型再调 send_sticker（Issue #41）
    assert.equal(saved.sent, true);
    assert.equal(saved.messageId, 7);
    assert.equal(f.sends.length, 1, '生成成功后必须已经发出去一次');
    assert.equal(f.sends[0].mode, 'sticker', '默认仍按表情发送（旧行为不变）');
    assert.equal(f.ctx.session.sent.length, 1, '会话记录里要有这条图片');
    const forSend = await f.manager.findForSend(saved.id);
    assert.ok(forSend?.url?.startsWith('base64://'), '有 localFile 的条目要能给 base64 内联地址');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('generate_image 传 send:false 时只落库、不发消息', async () => {
  resetImageQuotaForTest();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })
  });
  try {
    const f = context();
    const res = await tool('generate_image').execute(f.ctx, { prompt: '先存着', send: false });
    assert.equal(res.isError, undefined, res.content);
    const body = JSON.parse(res.content);
    assert.equal(body.sent, false);
    assert.ok(f.manager.entries.find((e) => e.id === body.id), '图片仍要进表情库');
    assert.equal(f.sends.length, 0, 'send:false 不该发消息');
    assert.equal(f.ctx.session.sent.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('端到端：url 形态的生成结果会被下载后再落库（不存临时链接）', async () => {
  resetImageQuotaForTest();
  const { updateConfig } = await import('../src/core/config.js');
  // 起一个真的本地 HTTP 服务当"图片 CDN"：下载走的是 safeFetchBinary（真实现，含 SSRF 校验），
  // 内网地址要 security.allowPrivateImageHosts 才放行 —— 那个开关本就是为本地测试/自建图床准备的。
  const httpMod = await import('node:http');
  const server = httpMod.default.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  updateConfig({ security: { allowPrivateImageHosts: true } });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/images/generations')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/gen.png` }] }) };
    }
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  try {
    const f = context();
    const res = await tool('generate_image').execute(f.ctx, { prompt: '海边落日' });
    assert.equal(res.isError, undefined, `生成失败：${res.content}`);
    const saved = JSON.parse(res.content);
    const entry = f.manager.entries.find((e) => e.id === saved.id);
    assert.ok(entry?.localFile, 'url 形态也要落盘成本地文件（临时链接会过期）');
    const bytes = fs.readFileSync(path.join(dataDir, entry.localFile));
    assert.equal(bytes.toString('hex'), PNG.toString('hex'), '落盘的要是下载到的那些字节');
  } finally {
    globalThis.fetch = realFetch;
    updateConfig({ security: { allowPrivateImageHosts: false } });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('闸门与守卫：超限拒绝、未配置拒绝、提示词过长拒绝', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
  };
  try {
    // maxPerHour = 1（配置文件里就设的 1）：第一张成功，第二张被闸门拒
    resetImageQuotaForTest();
    const f = context();
    const first = await tool('generate_image').execute(f.ctx, { prompt: '第一张' });
    assert.equal(first.isError, undefined, `第一张应成功：${first.content}`);
    const second = await tool('generate_image').execute(f.ctx, { prompt: '第二张' });
    assert.equal(second.isError, true);
    assert.match(second.content, /画图额度用完了/);
    assert.equal(calls, 1, '被拒的那次不能真的发请求（按张计费）');
    assert.equal(imageGenMaxPerHour(), 1);

    // 提示词过长：在读配置之前就拒
    const long = await tool('generate_image').execute(f.ctx, { prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) });
    assert.equal(long.isError, true);
    assert.match(long.content, /太长/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('守卫：地址指向别家却只填了模型 Key → 拒绝并说明原因（不把模型 Key 发出去）', async () => {
  const { updateConfig } = await import('../src/core/config.js');
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; };
  try {
    updateConfig({ imageGen: { enabled: true, model: 'm', baseUrl: 'https://elsewhere.example.com/v1', maxPerHour: 5 } });
    const f = context();
    const res = await tool('generate_image').execute(f.ctx, { prompt: 'x' });
    assert.equal(res.isError, true);
    assert.match(res.content, /不是同一家/);
    assert.equal(called, false, '守卫必须在发请求之前拦住');
  } finally {
    globalThis.fetch = realFetch;
    updateConfig({ imageGen: { enabled: true, model: 'gpt-image-1', baseUrl: '', maxPerHour: 1 } });
  }
});

// 并发封顶（2026-10-01 审查）：peek → 生成 → tryConsume 的组合在并发下会双双通过 peek，
// 上限被突破且超限那张照样计费。现在是"事前原子消费 + 失败退还"。
test('并发两张只能出一张（maxPerHour=1 时闸门必须原子）', async () => {
  const { updateConfig } = await import('../src/core/config.js');
  updateConfig({ imageGen: { enabled: true, model: 'gpt-image-1', baseUrl: '', maxPerHour: 1 } });
  resetImageQuotaForTest();
  const realFetch = globalThis.fetch;
  let calls = 0;
  let release = null;
  const gatePromise = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => {
    calls += 1;
    await gatePromise;   // 卡住提供方：两个调用都先走到闸门，再一起放行
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
  };
  try {
    const f1 = context();
    const f2 = context();
    const first = tool('generate_image').execute(f1.ctx, { prompt: '并发甲' });
    const second = tool('generate_image').execute(f2.ctx, { prompt: '并发乙' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [a, b] = await Promise.all([first, second]);
    const okCount = [a, b].filter((r) => r.isError === undefined).length;
    assert.equal(okCount, 1, `最多只能出一张（拿到 ${okCount} 张）`);
    const refused = [a, b].find((r) => r.isError);
    assert.match(refused.content, /画图额度用完了/);
    assert.equal(calls, 1, '被拒的那次不能真的发请求（按张计费）');
  } finally {
    globalThis.fetch = realFetch;
    updateConfig({ imageGen: { enabled: true, model: 'gpt-image-1', baseUrl: '', maxPerHour: 1 } });
  }
});

test('生成失败会把预扣的额度退回来（失败不白花额度）', async () => {
  const { updateConfig } = await import('../src/core/config.js');
  updateConfig({ imageGen: { enabled: true, model: 'gpt-image-1', baseUrl: '', maxPerHour: 1 } });
  resetImageQuotaForTest();
  const realFetch = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = async () => {
    attempt += 1;
    if (attempt === 1) return { ok: false, status: 500, text: async () => 'provider down' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
  };
  try {
    const f1 = context();
    const failed = await tool('generate_image').execute(f1.ctx, { prompt: '第一次会失败' });
    assert.equal(failed.isError, true, '提供方 500 应当报错');
    const f2 = context();
    const retry = await tool('generate_image').execute(f2.ctx, { prompt: '重试应当放行' });
    assert.equal(retry.isError, undefined, `失败不该吃掉额度（第二次被拒了）：${retry.content}`);
  } finally {
    globalThis.fetch = realFetch;
    updateConfig({ imageGen: { enabled: true, model: 'gpt-image-1', baseUrl: '', maxPerHour: 1 } });
  }
});

test('系统提示词不再教「生成后再调 send_sticker」（否则一次生图发两张）', () => {
  const prompt = fs.readFileSync(path.resolve('src/llm/prompt.js'), 'utf8');
  assert.doesNotMatch(prompt, /再用 send_sticker 发出去/);
  assert.match(prompt, /生成后会自动发到当前会话/);
});

test('imageGen.sendAs=image 时生成图按普通图片发送（issue #67）', async () => {
  resetImageQuotaForTest();
  const { updateConfig } = await import('../src/core/config.js');
  updateConfig({ imageGen: { sendAs: 'image', autoSend: true } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })
  });
  try {
    const f = context();
    const res = await tool('generate_image').execute(f.ctx, { prompt: '发普通图片' });
    assert.equal(res.isError, undefined, res.content);
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].mode, 'image', 'sendAs=image 必须走 sendImage，不能带表情标记');
    assert.equal(f.ctx.session.sent[0].type, 'image');
  } finally {
    globalThis.fetch = realFetch;
    updateConfig({ imageGen: { sendAs: 'sticker' } });
  }
});

test('imageGen.autoSend=false 时只入库、不自动发送', async () => {
  resetImageQuotaForTest();
  const { updateConfig } = await import('../src/core/config.js');
  updateConfig({ imageGen: { autoSend: false } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })
  });
  try {
    const f = context();
    const res = await tool('generate_image').execute(f.ctx, { prompt: '只存不发' });
    assert.equal(res.isError, undefined, res.content);
    const body = JSON.parse(res.content);
    assert.equal(body.sent, false);
    assert.ok(f.manager.entries.find((e) => e.id === body.id));
    assert.equal(f.sends.length, 0, '全局关闭自动发送后不该发消息');
  } finally {
    globalThis.fetch = realFetch;
    updateConfig({ imageGen: { autoSend: true } });
  }
});

test('图生图端到端：sourceMessageId（含多图选择与引用回退）把参考图塞进 image 字段', async (t) => {
  resetImageQuotaForTest();
  const http = await import('node:http');
  const { closeServer } = await import('./helpers/cleanup.mjs');
  const { updateConfig } = await import('../src/core/config.js');
  updateConfig({
    imageGen: { enabled: true, model: 'qwen-image-2.1-turbo', baseUrl: '', maxPerHour: 3, autoSend: true },
    security: { allowPrivateImageHosts: true }
  });

  // 用两份不同内容的合法 PNG 区分 imageIndex=1 与 imageIndex=2
  const PNG2 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAEjDAGACCKAoFF5l6tAAAAAElFTkSuQmCC',
    'base64'
  );
  const imgServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(req.url === '/two.png' ? PNG2 : PNG);
  });
  await new Promise((resolve) => imgServer.listen(0, '127.0.0.1', resolve));
  const imgBase = `http://127.0.0.1:${imgServer.address().port}`;
  t.after(() => closeServer(imgServer));

  const realFetch = globalThis.fetch;
  const genCalls = [];
  globalThis.fetch = async (url, req) => {
    const target = String(url);
    if (target.startsWith(imgBase)) return realFetch(url, req);
    genCalls.push({ url: target, body: JSON.parse(req.body || '{}') });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })
    };
  };

  try {
    const entries = new Map([
      ['101', {
        mid: 101,
        media: [
          { kind: 'image', url: `${imgBase}/one.png` },
          { kind: 'image', url: `${imgBase}/two.png` }
        ]
      }],
      ['102', {
        mid: 102,
        media: [],
        reply: { messageId: '101', sender: '张三', text: '[图片]' }
      }],
      ['103', {
        mid: 103,
        media: [{ kind: 'video', url: `${imgBase}/v.mp4` }]
      }]
    ]);
    const f = context({
      store: {
        activeMembers: () => [],
        recent: () => [...entries.values()],
        findByMid: (_chatKey, mid) => entries.get(String(mid).replace(/^#+/, '')) || null
      }
    });

    // ① 指定第 2 张图 + 带 # 前缀的 sourceMessageId
    const res1 = await tool('generate_image').execute(f.ctx, {
      prompt: '改成水彩画风',
      sourceMessageId: '#101',
      imageIndex: 2
    });
    assert.equal(res1.isError, undefined, res1.content);
    const body1 = JSON.parse(res1.content);
    assert.equal(body1.mode, 'img2img');
    assert.equal(genCalls[0].body.image, `data:image/png;base64,${PNG2.toString('base64')}`);
    const saved1 = f.manager.entries.find((e) => e.id === body1.id);
    assert.ok(saved1.localNote.startsWith('图生图：'));
    assert.ok(saved1.tags.includes('图生图'));

    // ② 模型传了引用回复那条消息 #102：自动顺着 reply.messageId 回退到 #101 第 1 张图
    const res2 = await tool('generate_image').execute(f.ctx, {
      prompt: '加个墨镜',
      sourceMessageId: '102'
    });
    assert.equal(res2.isError, undefined, res2.content);
    assert.equal(genCalls[1].body.image, `data:image/png;base64,${PNG.toString('base64')}`);

    // ③ sourceStickerId：直接拿刚生成的图继续改
    const res3 = await tool('generate_image').execute(f.ctx, {
      prompt: '背景换成海边',
      sourceStickerId: body1.id
    });
    assert.equal(res3.isError, undefined, res3.content);
    assert.equal(genCalls[2].body.image, `data:image/png;base64,${PNG.toString('base64')}`);

    // ④ 只有视频没有图：报错且不消耗第 4 次额度（前面用掉 3/3；先重设额度测不消耗）
    resetImageQuotaForTest();
    updateConfig({ imageGen: { maxPerHour: 1 } });
    const badVideo = await tool('generate_image').execute(f.ctx, {
      prompt: '改图',
      sourceMessageId: '103'
    });
    assert.equal(badVideo.isError, true);
    assert.match(badVideo.content, /只有视频/);

    const badBoth = await tool('generate_image').execute(f.ctx, {
      prompt: '改图',
      sourceMessageId: '101',
      sourceStickerId: body1.id
    });
    assert.equal(badBoth.isError, true);
    assert.match(badBoth.content, /只能传一个/);

    // 前两次参考图解析失败绝不能扣掉 maxPerHour=1 的额度
    const afterBad = await tool('generate_image').execute(f.ctx, { prompt: '正常出图' });
    assert.equal(afterBad.isError, undefined, `参考图校验失败不应消耗额度：${afterBad.content}`);
  } finally {
    globalThis.fetch = realFetch;
    updateConfig({
      imageGen: { enabled: true, model: 'gpt-image-1', baseUrl: '', maxPerHour: 1, autoSend: true },
      security: { allowPrivateImageHosts: false }
    });
  }
});
