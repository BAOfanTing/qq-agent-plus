// 本地回归：sender 的网络层错误会重试一次，非网络错误不重试。
//
// 用法：
//   T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-sender-retry.mjs
//
// 重要：必须用临时 QQ_AGENT_DATA_DIR（本用例会往里面写 config.json），
//       绝不能指向生产数据目录，否则会覆盖线上配置。
//       下面先给临时 DATA_DIR 种一份放行的 config.json（access.js 的 assertCanSend
//       会按它拦截发送），再动态 import 模块。
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.QQ_AGENT_DATA_DIR;
if (!dataDir) {
  console.error('必须设置 QQ_AGENT_DATA_DIR 指向一个临时目录，例如：T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-sender-retry.mjs');
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  // canRun 三要素：runtime.active + allow 放行 + 时间门放行
  runtime: { mode: 'active', paused: false },
  allow: { private: ['100000001'] },
  allowAllWhenEmpty: true
}));
const { SendQueue } = await import(new URL('../../src/onebot/sender.js', import.meta.url).href);

function makeStore() {
  const sent = [];
  return {
    sent,
    beginSend: () => 'op-' + Math.random().toString(36).slice(2, 8),
    finishSend: (id, info) => sent.push(info && info.messageId ? 'ok' : 'fail'),
    hasUncertainEffects: () => false,
    appendSelf: () => {},
    findByMid: () => null
  };
}

const store = makeStore();

// 用例 1：第一次 fetch failed，第二次成功 → 应该重试并发出
let calls1 = 0;
const onebot1 = {
  async sendText(kind, id, text) {
    calls1 += 1;
    if (calls1 === 1) throw new TypeError('fetch failed');
    return { message_id: 999 };
  }
};
const q1 = new SendQueue({ onebot: onebot1, store });
const r1 = await q1.sendTextBatch('private:100000001', ['网络抖动测试'], {});
console.log('用例1（fetch failed 后重试）: 调用次数=%d 结果=%s', calls1, JSON.stringify(r1.sent));

// 用例 2：非网络错误（限频/参数）不该重试
let calls2 = 0;
const onebot2 = {
  async sendText() {
    calls2 += 1;
    throw new Error('发送频率超限（每分钟最多 80 条），请等一会再发');
  }
};
const q2 = new SendQueue({ onebot: onebot2, store });
let err2 = '';
try { await q2.sendTextBatch('private:100000001', ['限频不该重试'], {}); } catch (e) { err2 = String(e.message); }
console.log('用例2（非网络错误）: 调用次数=%d 报错=%s', calls2, err2.slice(0, 40));

// 用例 3：两次都网络失败 → 只重试一次，最终抛错
let calls3 = 0;
const onebot3 = { async sendText() { calls3 += 1; throw new TypeError('fetch failed'); } };
const q3 = new SendQueue({ onebot: onebot3, store });
let err3 = '';
try { await q3.sendTextBatch('private:100000001', ['一直失败'], {}); } catch (e) { err3 = String(e.message); }
console.log('用例3（连续网络失败）: 调用次数=%d 报错=%s', calls3, err3.slice(0, 40));

console.log(
  (calls1 === 2 && r1.sent.length === 1 ? 'PASS' : 'FAIL') + ' 网络错误重试一次; ' +
  (calls2 === 1 ? 'PASS' : 'FAIL') + ' 非网络错误不重试; ' +
  (calls3 === 2 ? 'PASS' : 'FAIL') + ' 最多重试一次'
);
