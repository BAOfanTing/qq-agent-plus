// 本地回归：思考模式下的强制 tool_choice 降级。
//
// 背景（线上真实故障）：贴纸判断强制指定 tool_choice（要模型提交 submit_sticker_pick），
// 而 DeepSeek 系的思考模式不接受强制 tool_choice，整次请求直接 400
// "Thinking mode does not support this tool_choice"，重试 3 次后整张图被跳过。
// 现在 llm.js 在"思考开启 + 强制 tool_choice"时降级为 auto；
// 思考关闭时（如 purpose=chat）保持原样，因为那时强制值是合法的。
//
// 用法：QQ_AGENT_DATA_DIR=$(mktemp -d) node test/local/test-thinking-toolchoice.mjs
// 必须用临时数据目录，不能指向生产数据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.QQ_AGENT_DATA_DIR || !fs.existsSync(process.env.QQ_AGENT_DATA_DIR)) {
  console.error('必须设置 QQ_AGENT_DATA_DIR 为已存在的临时目录（不要指向生产数据）');
  process.exit(2);
}

const dataDir = process.env.QQ_AGENT_DATA_DIR;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active', paused: false },
  allow: { private: ['100000001'] },
  allowAllWhenEmpty: true,
  api: {
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'mock',
    // 聊天关思考、其余（判断类）保持开启 —— 与线上配置一致
    thinking: { chat: 'off', default: 'on' }
  }
}));

const { chatCompletion } = await import(new URL('../../src/llm.js', import.meta.url).href);
const forced = { type: 'function', function: { name: 'submit_sticker_pick' } };
const tools = [{ type: 'function', function: { name: 'submit_sticker_pick', parameters: {} } }];

const originalFetch = globalThis.fetch;
const bodies = [];
globalThis.fetch = async (_url, request) => {
  bodies.push(JSON.parse(request.body));
  return Response.json({
    choices: [{ message: { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'submit_sticker_pick', arguments: '{}' } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  });
};

const cases = [];
try {
  // 1) 判断类（不传 purpose → thinking on）：强制值必须降级为 auto
  bodies.length = 0;
  await chatCompletion({ messages: [{ role: 'user', content: '收还是不收？' }], tools, toolChoice: forced });
  cases.push(['思考开启 + 强制 tool_choice → 降级 auto', bodies[0]?.tool_choice === 'auto' && bodies[0]?.thinking === undefined]);

  // 2) 聊天类（purpose=chat → thinking off）：强制值保持原样，并带上关闭思考的字段
  bodies.length = 0;
  await chatCompletion({ messages: [{ role: 'user', content: '在吗' }], tools, toolChoice: forced, purpose: 'chat' });
  cases.push(['思考关闭 + 强制 tool_choice → 原样保留', bodies[0]?.tool_choice?.function?.name === 'submit_sticker_pick'
    && bodies[0]?.thinking?.type === 'disabled']);

  // 3) 默认的 auto 不受影响
  bodies.length = 0;
  await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], tools });
  cases.push(['默认 auto 不受影响', bodies[0]?.tool_choice === 'auto']);
} finally {
  globalThis.fetch = originalFetch;
}

let ok = 0;
for (const [name, pass] of cases) {
  if (pass) ok += 1;
  console.log('%s %s', pass ? 'PASS' : 'FAIL', name);
}
console.log('结果: %d/%d', ok, cases.length);
process.exit(ok === cases.length ? 0 : 1);
