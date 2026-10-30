import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CAP_METHODS } from '../src/plugins/protocol.js';
import { createCapabilities, pluginDataDir } from '../src/plugins/capabilities.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-send-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const media = path.join(pluginDataDir(root, 'img-demo'), 'media');
  fs.mkdirSync(media, { recursive: true });
  const calls = [];
  const sender = {
    sendImage: async (...args) => { calls.push(['image', ...args]); return { message_id: 1 }; },
    groupFile: async (...args) => { calls.push(['file', ...args]); return { message_id: 2 }; }
  };
  const cap = createCapabilities({ pluginId: 'img-demo', dataDir: root, getSender: () => sender, log: () => {} });
  return { media, calls, cap };
}

test('cap.send.file：图片按魔数走 image 消息段，不看扩展名', async (t) => {
  const { media, calls, cap } = setup(t);
  // 扩展名是 .bin，但内容以 PNG 魔数开头：必须识别成图片。
  fs.writeFileSync(path.join(media, 'cover.bin'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  const result = await cap.methods[CAP_METHODS.sendFile]({ chatKey: 'group:1', file: 'cover.bin' });
  assert.equal(result.image, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'image');
  assert.match(calls[0][2].url, /^base64:\/\//, '小图内联发送，不依赖协议端能读宿主路径');
  assert.equal(Buffer.from(calls[0][2].url.slice('base64://'.length), 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('cap.send.file：非图片仍走群文件', async (t) => {
  const { media, calls, cap } = setup(t);
  fs.writeFileSync(path.join(media, 'notes.bin'), 'plain text');
  const result = await cap.methods[CAP_METHODS.sendFile]({ chatKey: 'group:1', file: 'notes.bin', name: 'notes.txt' });
  assert.equal(result.image, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'file');
  assert.equal(calls[0][2].name, 'notes.txt');
});
