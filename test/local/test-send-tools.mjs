// 本地回归：工具层发送的 replyToMessageId 归一化与参数透传
// （send_message / send_sticker / send_face / send_poke 不再抛 "is not defined"，
//   且 "#123" 这类带 # 的引用 id 会被归一化成纯数字）。
//
// 用法：
//   T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-send-tools.mjs
//
// 重要：必须用临时 QQ_AGENT_DATA_DIR——本用例会往里面复制表情名表，
//       绝不能指向生产数据目录。
//       可选：QQ_AGENT_FACE_NAMES_SRC 指向含 face-names.json 的目录（如生产 data），
//       设了就把真实表情名表复制进临时目录，让 send_face 用真实名字；不设则跳过。
import fs from 'node:fs';
import path from 'node:path';

const tmp = process.env.QQ_AGENT_DATA_DIR;
if (!tmp) {
  console.error('必须设置 QQ_AGENT_DATA_DIR 指向一个临时目录，例如：T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-send-tools.mjs');
  process.exit(2);
}
fs.mkdirSync(tmp, { recursive: true });
const faceSrc = process.env.QQ_AGENT_FACE_NAMES_SRC;
if (faceSrc) {
  for (const f of ['face-names.json', 'face-names-extra.json']) {
    const src = path.join(faceSrc, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
  }
}
const { buildToolDefs, executeTool } = await import(new URL('../../src/tools-core.js', import.meta.url).href);
const calls = [];
const sender = new Proxy({}, {
  get(_t, name) {
    if (name === 'then') return undefined;
    return async (...args) => { calls.push({ method: String(name), args }); return { message_id: 42, sent: [{ text: 'x' }], failed: [] }; };
  }
});
const ctx = {
  chatKey: 'group:123456', kind: 'group', sender,
  session: { leaseId: 'test-lease', sent: [] },
  store: { findByMid: () => ({ id: 1 }), activeMembers: () => [{ userId: '12345', name: '测试' }] },
  stickers: { find: async () => ({ id: 'st1', url: 'http://example.com/a.png', desc: '测试表情' }), findForSend: async () => ({ id: 'st1', url: 'http://example.com/a.png', desc: '测试表情' }), markUsed: async () => {} },
  participants: new Set(['12345']),
  emit() {}, signal: undefined
};
const defs = buildToolDefs();
let fail = 0;
const run = async (name, args) => {
  let text;
  try {
    const r = await executeTool(defs, ctx, name, JSON.stringify(args));
    text = String(r?.content ?? '');
  } catch (e) { text = 'THREW: ' + e.message; }
  const bad = /is not defined|THREW/.test(text);
  if (bad) fail++;
  console.log((bad ? 'FAIL ' : ' ok  ') + name + ' ' + JSON.stringify(args) + ' → ' + text.slice(0, 90).replace(/\n/g, ' '));
};
await run('send_message', { messages: ['测试一条'], replyToMessageId: '#-123456' });
await run('send_message', { messages: ['@测试'], atUserId: '12345' });
await run('send_sticker', { stickerId: 'st1', replyToMessageId: '#123456' });
await run('send_face', { name: '微笑', replyToMessageId: '#123456' });
await run('send_poke', { userId: '12345' });
console.log('--- 实际传给 sender 的引用 id ---');
for (const c of calls) {
  const opts = c.args.find((a) => a && typeof a === 'object' && 'replyToMessageId' in a);
  if (opts) console.log(' ', c.method, '→ replyToMessageId =', JSON.stringify(opts.replyToMessageId));
}
console.log(fail ? ('TEST_FAIL ' + fail) : 'TEST_OK');
