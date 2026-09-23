// 镜像站回退的真实控制流（Issue #5：国内拉不到 Docker Hub）。
//
// 不重跑整个 deploy-all.sh（它会装服务、写系统配置），而是把"拉镜像"这一段原样抽出来，
// 用桩 docker 跑：直连失败 → 逐个镜像站重试 → 成功就把 .env 里的引用一起改掉；
// 全失败才打指引并退出。抽的是源码本身，所以断言的是真控制流，不是复述。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repo, 'deploy-all.sh');

function hasBash() {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

/** 抽出 deploy-all.sh 里"下载镜像"整段（从注释到 die 之后的 fi）。 */
function pullBlock() {
  const lines = fs.readFileSync(scriptPath, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('# 拉一个引用：每个地址最多 3 次'));
  assert.ok(start >= 0, '没找到拉镜像那段（脚本结构变了就要同步改这个用例）');
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    if (/Failed to download SnowLuma image/.test(lines[i])) {
      end = lines.findIndex((l, j) => j > i && l === 'fi');
      break;
    }
  }
  assert.ok(end > start, '没找到拉镜像那段的结尾');
  return lines.slice(start, end + 1).join('\n');
}

function runBlock({ image, mirrors, succeedFor }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pull-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, `SNOWLUMA_IMAGE=${image}\nSNOWLUMA_CONTAINER=qq-agent-snowluma\n`, { mode: 0o600 });
  const harness = `
set -u
ENV_FILE=${JSON.stringify(envFile)}
IMAGE=${JSON.stringify(image)}
IMAGE_MIRRORS=(${mirrors.map((m) => JSON.stringify(m)).join(' ')})
STUB_DIR=${JSON.stringify(dir)}
die() { printf 'DIE: %s\\n' "$*" >&2; exit 3; }
step() { printf 'STEP: %s\\n' "$*"; }
sleep() { :; }
# 桩：只有落在 succeedFor 里的引用才拉得动
docker_call() {
  local sub="$1" ref="$2"
  if [[ "$sub" == pull ]]; then
    for want in ${succeedFor.map((s) => JSON.stringify(s)).join(' ')}; do
      [[ "$ref" == "$want" ]] && { printf 'PULLED %s\\n' "$ref"; return 0; }
    done
    printf 'Error response from daemon: dial tcp 31.13.82.169:443: i/o timeout\\n' >&2
    return 1
  fi
  return 0
}
${pullBlock()}
printf 'FINAL_IMAGE=%s\\n' "$IMAGE"
`;
  const res = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  const envAfter = fs.readFileSync(envFile, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: res.status, out: `${res.stdout}${res.stderr}`, envAfter };
}

test('直连失败时按顺序试镜像站，成功后把 .env 里的引用一起改掉', { skip: !hasBash() && '需要 bash' }, () => {
  const image = 'motricseven7/snowluma:v1.14.15';
  const good = `docker.m.daocloud.io/${image}`;
  const r = runBlock({
    image,
    mirrors: ['unreachable.example', 'docker.m.daocloud.io'],
    succeedFor: [good]
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Retrying through image mirror unreachable\.example/);
  assert.match(r.out, /Retrying through image mirror docker\.m\.daocloud\.io/);
  assert.match(r.out, new RegExp(`PULLED docker\\.m\\.daocloud\\.io/${image.replace(/[.:/]/g, '\\$&')}`));
  assert.match(r.out, new RegExp(`FINAL_IMAGE=docker\\.m\\.daocloud\\.io/${image.replace(/[.:/]/g, '\\$&')}`));
  assert.ok(r.envAfter.includes(`SNOWLUMA_IMAGE=docker.m.daocloud.io/${image}`), 'compose 走 --env-file，引用要同步');
  assert.ok(r.envAfter.includes('SNOWLUMA_CONTAINER=qq-agent-snowluma'), '其它行不能被改掉');
});

test('直连成功就不碰镜像站', { skip: !hasBash() && '需要 bash' }, () => {
  const image = 'motricseven7/snowluma:v1.14.15';
  const r = runBlock({ image, mirrors: ['docker.m.daocloud.io'], succeedFor: [image] });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /Retrying through image mirror/);
  assert.ok(r.envAfter.includes(`SNOWLUMA_IMAGE=${image}`));
});

test('全都拉不到时打指引再退出（含三种办法与"镜像站是第三方"）', { skip: !hasBash() && '需要 bash' }, () => {
  const image = 'motricseven7/snowluma:v1.14.15';
  const r = runBlock({ image, mirrors: ['docker.m.daocloud.io'], succeedFor: [] });
  assert.equal(r.status, 3, `应当以 die 退出：${r.out}`);
  for (const needle of ['QQ_AGENT_IMAGE_MIRROR=<mirror>', 'registry-mirrors', 'docker save', '镜像站由第三方提供']) {
    assert.ok(r.out.includes(needle), `指引里应包含：${needle}`);
  }
  assert.match(r.out, /DIE: Failed to download SnowLuma image/);
});
