// 本地回归：空间互动接口异常时不再每秒重试（指数退避到分钟级）。
//
// 这是 2026-09-17 那次"失败后 1.4 秒重试一次、6 分钟刷了两百次"事故的回归用例。
// 用假时钟 + 可控定时器，毫秒级验证：首轮失败只尝试一次，之后退避 2 分钟 → 4 分钟翻倍。
//
// 用法：T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-qzone-backoff.mjs
//
// 重要：必须用临时 QQ_AGENT_DATA_DIR（本用例会往里面写 config.json 和状态文件），
//       绝不能指向生产数据目录。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dataDir = process.env.QQ_AGENT_DATA_DIR;
if (!dataDir) {
  console.error('必须设置 QQ_AGENT_DATA_DIR 指向一个临时目录，例如：T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-qzone-backoff.mjs');
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ qzoneInteractions: { enabled: true } }));

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repoRoot = path.resolve(here, '..', '..');
const { QzoneInteractionManager } = await import(
  pathToFileURL(path.join(repoRoot, 'src', 'qzone-interactions.js')).href
);

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let fakeNow = Date.parse('2026-09-19T02:00:00Z');
const timers = [];
globalThis.setTimeout = (fn, ms) => {
  const handle = { fn, ms: Number(ms) || 0, canceled: false };
  timers.push(handle);
  return handle;
};
globalThis.clearTimeout = (handle) => {
  if (handle && typeof handle === 'object') handle.canceled = true;
};

let attempts = 0;
const onebot = {
  selfId: '10000001',
  async call() {
    attempts += 1;
    throw new Error('OneBot get_qzone_msg_list 失败: retcode=100 Unexpected status code: 501');
  }
};
const logs = [];
const mgr = new QzoneInteractionManager({
  onebot,
  now: () => fakeNow,
  sleep: () => Promise.resolve(),
  log: (...args) => logs.push(args.join(' '))
});

const peek = () => {
  const live = timers.filter((timer) => !timer.canceled);
  return live[live.length - 1] || null;
};
const fire = async () => {
  const timer = peek();
  if (!timer) throw new Error('没有排到下一次巡检');
  timer.canceled = true;
  timer.fn();
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    if (!mgr.running) break;
  }
  const next = peek();
  return next ? next.ms : -1;
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

try {
  mgr.start();
  const first = peek();
  check('启动后先等 15 秒再巡检', first?.ms === 15000, `排了 ${first?.ms}ms`);

  const afterFirst = await fire();
  check('首轮失败只尝试一次（修复前约每秒一次）', attempts === 1, `attempts=${attempts}`);
  check('失败后退避到 2 分钟', afterFirst === 120000, `实际 ${Math.round(afterFirst / 1000)}s`);
  check('一轮连续故障只报一条日志', logs.length === 1, `logs=${logs.length}`);

  fakeNow += 120000;
  const afterSecond = await fire();
  check('退避到期重试仍失败，且同样只尝试一次', attempts === 2, `attempts=${attempts}`);
  check('连续失败退避翻倍到 4 分钟', afterSecond === 240000, `实际 ${Math.round(afterSecond / 60000)} 分钟`);

  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'qzone-interactions.json'), 'utf8'));
  check('failStreak 记为 2', state.failStreak === 2, `failStreak=${state.failStreak}`);
} catch (error) {
  results.push(false);
  console.log('FAIL 用例异常终止:', error?.message ?? error);
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

console.log(`\n退避用例: ${results.filter(Boolean).length}/${results.length} 通过`);
process.exit(results.every(Boolean) ? 0 : 1);
