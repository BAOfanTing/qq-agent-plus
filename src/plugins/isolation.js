// 插件进程的隔离参数 —— 这是"插件生态"与"把机器交给陌生人"之间的那道门。
//
// 第 0 步 spike 的实测结论（本机 Node v24 + 生产 Node v22.23.2 两台都跑过，见下方 probe 的用法）：
//   `node --permission --allow-fs-read=<插件目录> <entry>`
//     · 读 /data/qq-agent/data/config.json（凭据所在）→ **ERR_ACCESS_DENIED**
//     · 读插件目录外的任何文件、import 目录外的模块 → **ERR_ACCESS_DENIED**
//     · child_process.spawn / execSync → **ERR_ACCESS_DENIED**
//     · worker_threads → **ERR_ACCESS_DENIED**
//     · 加载同目录的兄弟模块（多文件插件）→ 正常
//   拦不住的：
//     · **网络** —— `--allow-net` 这个 flag 在 v22/v24 上都不存在（`bad option`）。Node 的权限
//       模型覆盖 fs / child_process / worker / addons / wasi，**不覆盖网络**。所以"插件能自己联网"
//       是必须如实告知用户的事实（docs/PLUGINS.md 的信任声明里写明），不要假装拦住了。
//     · **环境变量** —— 子进程默认继承 env，`process.env.QQ_AGENT_*` 读得到。所以宿主 spawn 时
//       必须自己剥（见 host.js 的 childEnv()）。
//
// 因此这里的口径：fs 与子进程是真拦（这是最要紧的一条 —— 凭据读不到），网络拦不住就写在明处。
import { spawnSync } from 'node:child_process';

/** 本机 node 认不认 `--permission`（不认就只能走 fail-closed：拒绝加载插件）。 */
export function permissionFlagSupported() {
  const flags = process.allowedNodeEnvironmentFlags;
  return typeof flags?.has === 'function' && flags.has('--permission');
}

/**
 * spawn 插件进程用的参数。
 * 只给**只读 + 只读插件目录**：插件要存东西走 `cap.storage`（宿主侧落盘），
 * 于是插件进程连写权限都不需要 —— 少一项权限就少一类被写坏的东西。
 */
export function pluginNodeArgs({ pluginDir = '' } = {}) {
  const args = ['--permission'];
  // 权限模型会打一条 ExperimentalWarning 到 stderr，混在插件日志里既吵又容易被当成故障。
  // 老 node 不认这个 flag 时不加（认不认由 probeIsolation 实测）。
  if (process.allowedNodeEnvironmentFlags?.has?.('--disable-warning')) {
    args.push('--disable-warning=ExperimentalWarning');
  }
  if (pluginDir) args.push(`--allow-fs-read=${pluginDir}`);
  return args;
}

let cachedProbe = null;

/**
 * 真起一次子进程验证参数可用（`allowedNodeEnvironmentFlags` 只说明"认这个 flag"，
 * 不说明这组参数能跑起来）。结果进程内缓存 —— 一次约 30ms，没必要每次加载插件都跑。
 *
 * ⚠️ 缓存的是**结论**（能不能用），不是参数本身：`--allow-fs-read` 里是各插件自己的目录，
 * 必须由调用方按目录现算（缓存一份会把第一个插件的目录发给所有人）。
 * @returns {{ok:boolean, error?:string}}
 */
export function probeIsolation({ pluginDir, spawn = spawnSync, nodePath = process.execPath, force = false } = {}) {
  if (!force && cachedProbe) return cachedProbe;
  if (!permissionFlagSupported()) {
    cachedProbe = { ok: false, error: '本机 Node 不支持 --permission（权限模型），插件进程无法与宿主隔开' };
    return cachedProbe;
  }
  const runNode = spawn;
  const attempt = (args) => runNode(nodePath, [...args, '-e', ''], { encoding: 'utf8', timeout: 20000 });
  const first = attempt(pluginNodeArgs({ pluginDir }));
  if (first?.status === 0) { cachedProbe = { ok: true }; return cachedProbe; }
  // 某些老版本的 --disable-warning 写法不同 → 去掉它再试一次，别因为一条警告就判定隔离不可用
  const fallback = pluginNodeArgs({ pluginDir }).filter((a) => !a.startsWith('--disable-warning'));
  if (attempt(fallback)?.status === 0) { cachedProbe = { ok: true }; return cachedProbe; }
  const detail = String(first?.stderr || first?.error?.message || '').trim().split('\n').slice(-1)[0];
  cachedProbe = { ok: false, error: `隔离参数跑不起来：${detail || '未知原因'}` };
  return cachedProbe;
}

/** 给控制台/巡检用的口径说明：哪些拦得住、哪些拦不住。 */
export function isolationSummary() {
  const supported = permissionFlagSupported();
  return {
    supported,
    fs: supported,
    childProcess: supported,
    worker: supported,
    net: false,      // Node 权限模型里根本没有网络这一项（--allow-net 不存在）
    env: false       // 宿主自己剥，见 host.js
  };
}

/** 只测一次用：重置缓存（测试用）。 */
export function resetIsolationProbe() { cachedProbe = null; }
