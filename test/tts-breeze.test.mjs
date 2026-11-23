import assert from 'node:assert/strict';
import { test } from 'node:test';

const { synthesizeBreeze, breezeVoices, BREEZE_DEFAULT_URL } = await import('../src/llm/tts-breeze.js');
const { synthesizeSpeech } = await import('../src/llm/tts.js');
const { ttsConfigured } = await import('../src/llm/tts-openai.js');
const { ttsServiceOf } = await import('../src/llm/tts-presets.js');

function mockAudioResponse(size = 800, contentType = 'audio/mpeg') {
  const buf = Buffer.alloc(size, 0x55);
  buf.write('ID3', 0, 'ascii');
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString()
  };
}

test('Breeze：云端模式路径、请求头与 body 正确', async () => {
  const calls = [];
  const out = await synthesizeBreeze({
    cfg: {
      baseUrl: 'https://api.breeze.blue',
      apiKey: 'brz_test_key_123',
      voice: 'voc_8yud7hz7c9q2',
      model: 'breeze-tts-2',
      outputFormat: 'mp3_24000_128'
    },
    text: '晚安啦，早点休息。',
    fetchFn: async (url, req) => {
      calls.push({
        url: String(url),
        headers: req.headers,
        body: JSON.parse(req.body)
      });
      return mockAudioResponse();
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.breeze.blue/v1/text-to-speech/voc_8yud7hz7c9q2?output_format=mp3_24000_128&delivery=sync');
  assert.equal(calls[0].headers['xi-api-key'], 'brz_test_key_123');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.equal(calls[0].body.text, '晚安啦，早点休息。');
  assert.equal(calls[0].body.model_id, 'breeze-tts-2');
  assert.equal(out.format, 'mp3');
  assert.ok(out.buffer.length >= 800);
});

test('Breeze：缺 Key / 音色 id / 文本直接拒绝', async () => {
  await assert.rejects(
    synthesizeBreeze({ cfg: { apiKey: '', voice: 'voc_1' }, text: '你好' }),
    /没填 API Key/
  );
  await assert.rejects(
    synthesizeBreeze({ cfg: { apiKey: 'brz_1', voice: '' }, text: '你好' }),
    /没填音色 id/
  );
  await assert.rejects(
    synthesizeBreeze({ cfg: { apiKey: 'brz_1', voice: 'voc_1' }, text: '   ' }),
    /文本为空/
  );
});

test('Breeze：401、402、429 与非 audio 各有清晰报错', async () => {
  // 401
  await assert.rejects(
    synthesizeBreeze({
      cfg: { apiKey: 'bad', voice: 'voc_1' },
      text: '你好',
      fetchFn: async () => ({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"detail":"invalid key"}'
      })
    }),
    /HTTP 401：Key 不对或已撤销/
  );

  // 402
  await assert.rejects(
    synthesizeBreeze({
      cfg: { apiKey: 'bad', voice: 'voc_1' },
      text: '你好',
      fetchFn: async () => ({
        ok: false,
        status: 402,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"detail":"insufficient credits"}'
      })
    }),
    /HTTP 402：额度不够/
  );

  // 429
  await assert.rejects(
    synthesizeBreeze({
      cfg: { apiKey: 'bad', voice: 'voc_1' },
      text: '你好',
      fetchFn: async () => ({
        ok: false,
        status: 429,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"detail":"rate limit"}'
      })
    }),
    /HTTP 429：撞频率限制了/
  );

  // 200 但返回非 audio
  await assert.rejects(
    synthesizeBreeze({
      cfg: { apiKey: 'bad', voice: 'voc_1' },
      text: '你好',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"detail":"unexpected json"}'
      })
    }),
    /没返回音频/
  );
});

test('Breeze：本地模式打到 /v1/audio/speech，409 提示正在合成', async () => {
  const calls = [];
  const out = await synthesizeBreeze({
    cfg: {
      mode: 'local',
      baseUrl: 'http://127.0.0.1:8000',
      instructions: '清脆一点',
      guidanceScale: 2.5
    },
    text: '本地测试',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), body: req.body });
      return mockAudioResponse();
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/v1/audio/speech');
  assert.ok(calls[0].body instanceof FormData);
  assert.equal(calls[0].body.get('text'), '本地测试');
  assert.equal(calls[0].body.get('instruction'), '清脆一点');
  assert.equal(calls[0].body.get('cfg_scale'), '2.5');
  assert.equal(out.format, 'mp3');

  // 409
  await assert.rejects(
    synthesizeBreeze({
      cfg: { mode: 'local', baseUrl: 'http://127.0.0.1:8000' },
      text: '排队',
      fetchFn: async () => ({
        ok: false,
        status: 409,
        headers: new Headers(),
        text: async () => '{"detail":"already running"}'
      })
    }),
    /本地正在合成上一句/
  );
});

test('Breeze：breezeVoices 拉取音色列表', async () => {
  const res = await breezeVoices({
    baseUrl: 'https://api.breeze.blue',
    apiKey: 'brz_test',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        voices: [
          { voice_id: 'voc_aaa', name: '小鲸鱼音色', voice_type: 'custom' },
          { voice_id: 'voc_bbb', name: '大鲸鱼音色', origin: 'preset' }
        ]
      })
    })
  });
  assert.equal(res.ok, true);
  assert.equal(res.voices.length, 2);
  assert.deepEqual(res.voices[0], { id: 'voc_aaa', label: '小鲸鱼音色', cat: 'custom' });
  assert.deepEqual(res.voices[1], { id: 'voc_bbb', label: '大鲸鱼音色', cat: 'preset' });
});

test('统一入口：只写 provider=breeze 自动打到 Breeze 适配器，Key 按家取', async () => {
  const calls = [];
  const out = await synthesizeSpeech({
    cfg: {
      provider: 'breeze',
      keys: { breeze: 'brz_key_from_map' },
      voice: 'voc_8yud7hz7c9q2'
    },
    text: '分发到 Breeze 语音',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), headers: req.headers, body: JSON.parse(req.body) });
      return mockAudioResponse();
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['xi-api-key'], 'brz_key_from_map');
  assert.equal(calls[0].body.text, '分发到 Breeze 语音');
  assert.equal(calls[0].body.model_id, 'breeze-tts-2');
  assert.equal(out.format, 'mp3');

  // ttsConfigured 检查
  assert.equal(ttsConfigured({ tts: { enabled: true, provider: 'breeze', voice: 'voc_1' } }), true);
  assert.equal(ttsConfigured({ tts: { enabled: true, provider: 'breeze', voice: '' } }), false);

  // ttsServiceOf 检查
  assert.equal(ttsServiceOf({ provider: 'breeze' })?.id, 'breeze');
  assert.equal(ttsServiceOf({ baseUrl: 'https://api.breeze.blue' })?.id, 'breeze');
});
