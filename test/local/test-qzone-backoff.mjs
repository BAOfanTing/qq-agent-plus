// 本地回归：空间互动接口异常时不再每秒重试（指数退避到分钟级）。
//
// 用法：
//   T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-qzone-backoff.mjs
//
// 重要：必须用临时 QQ_AGENT_DATA_DIR（本用例会往里面写 config.json），
//       绝不能指向生产数据目录。
//       用例约需 25 秒：manager.start() 首次巡检在 15 秒后，然后等一次退避结果。
//       下面先种一份 enabled=true 的 config.json（manager.start() 会读它），再动态 import。
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.QQ_AGENT_DATA_DIR;
if (!dataDir) {
  console.error('必须设置 QQ_AGENT_DATA_DIR 指向一个临时目录，例如：T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-qzone-backoff.mjs');
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ qzoneInteractions: { enabled: true } }));
const { QzoneInteractionManager } = await import(new URL('../../src/qzone-interactions.js', import.meta.url).href);

const stateFile = '/tmp/qz-backoff-state.json';
try { fs.unlinkSync(stateFile); } catch {}

let attempts = 0;
const onebot = {
  async call() {
    attempts += 1;
    throw new Error('OneBot get_qzone_msg_list 失败: retcode=100 Unexpected status code: 501');
  }
};
const logs = [];
const mgr = new QzoneInteractionManager({
  onebot,
  log: (...args) => logs.push(args.join(' ')),
  stateFile
});
mgr.start(); // 首次巡检在 15 秒后
const t0 = Date.now();
await new Promise((r) => setTimeout(r, 23000));
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const seconds = ((Date.now() - t0) / 1000).toFixed(1);
console.log('经过 %ss：调用次数=%d failStreak=%s', seconds, attempts, state.failStreak);
console.log('日志：', logs.map((l) => l.slice(0, 70)).join(' || '));
const nextRunIn = Math.round((mgr.nextRunAt - Date.now()) / 1000);
console.log('下一次巡检还有 %ds（退避应为 ~120s 级别）', nextRunIn);
console.log(
  (attempts === 1 ? 'PASS' : 'FAIL') + ' 23 秒内只尝试一次（修复前约每秒一次）; ' +
  (state.failStreak === 1 ? 'PASS' : 'FAIL') + ' failStreak=1; ' +
  (nextRunIn > 60 ? 'PASS' : 'FAIL') + ' 下一次排到分钟级'
);
process.exit(0);
