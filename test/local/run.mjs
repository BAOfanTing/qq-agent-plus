// test/local 的跑法统一入口：给每个用例准备一个临时数据目录，逐个执行。
//
// 为什么要这个：这些用例都要求 QQ_AGENT_DATA_DIR 指向临时目录（绝不指向生产数据），
// 直接写进 npm script 在各个 shell 里难以跨平台；CI 与本地都用这一份逻辑。
//
// 用法：node test/local/run.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CASES = [
  'test-inline-fallback.mjs',
  'test-sender-retry.mjs',
  'test-qzone-backoff.mjs',
  'test-sticker-lookup.mjs',
  'test-send-tools.mjs',
  'test-thinking-toolchoice.mjs'
];

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-local-'));
let failed = 0;

try {
  for (const file of CASES) {
    const target = path.join(here, file);
    if (!fs.existsSync(target)) {
      console.error(`FAIL ${file}（文件不存在）`);
      failed += 1;
      continue;
    }
    const run = spawnSync(process.execPath, [target], {
      stdio: 'inherit',
      env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir }
    });
    const ok = run.status === 0;
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${file}`);
  }
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n本地回归结果: ${CASES.length - failed}/${CASES.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
