# 插件（第三方扩展）

> **状态：宿主骨架已落地（v1 第一段）。** 目前可用的部分：插件目录约定、manifest 校验、
> 独立进程宿主（隔离 / 心跳 / 超时 / 崩溃重启）、能力鉴权与宿主侧实现、注册表与默认拒门控。
> 还没接的：把插件工具挂进模型工具表、入站消息投递、周期任务驱动、控制台「插件」页与一键安装、
> 示例插件。分期见文末。

## 这是什么

让别人（或你自己）用一份 `plugin.json` + 一个入口 JS 给机器人加能力：暴露只读工具给模型、
看到入站消息、按周期跑事。**插件跑在独立子进程里**，通过 stdio 上的 JSON 协议与宿主对话。

## 先说信任（装之前必须知道）

- **插件是第三方代码。** 装上一个插件 = 让它的作者在你的服务器上跑代码。请只装你看得懂或
  愿意信任的插件。
- **凭据读不到。** 插件进程被 Node 的权限模型关在只读自己目录的沙箱里：实测
  `data/config.json`（里面有 API Key、控制台 Token、OneBot Token）读出来是 `ERR_ACCESS_DENIED`；
  起子进程、开 worker、写文件同样被拒；宿主还会剥掉环境变量（否则 `QQ_AGENT_DATA_DIR` 之类
  会漏过去）。
- **网络拦不住，这是如实告知。** Node 的权限模型覆盖 fs / 子进程 / worker / addons，**不覆盖网络**
  （`--allow-net` 这个 flag 在 Node 22/24 上都不存在）。也就是说：插件拿不到你的凭据，但它自己
  能联网 —— 它看到的内容有可能被外发。要真禁网得靠命名空间或容器，v1 做不到。
- **模型的工具描述会被插件作者影响。** manifest 里的名字与描述会进系统提示词（宿主会做段头
  弱化与递归清洗，但字面内容仍由作者决定），插件工具返回的内容一律按"外部信息"对待。

## 目录与 manifest

插件放 **`$DATA_DIR/plugins/<id>/`**（`QQ_AGENT_DATA_DIR`，默认 `<应用目录>/data`）。
放这里是因为版本更新只用 rsync 铺源码树、数据目录在保留清单里 —— 插件不会被升级抹掉。

```
$DATA_DIR/plugins/mc-status/
├── plugin.json       # manifest（必需）
└── index.mjs         # 入口（默认 index.mjs，可用 entry 指定）
```

```json
{
  "id": "mc-status",
  "apiVersion": 1,
  "name": "Minecraft 服务器状态",
  "version": "1.0.0",
  "description": "查一台 MC 服务器的在线玩家",
  "capabilities": ["tools", "http"],
  "tools": [
    {
      "name": "players",
      "description": "查指定服务器的在线玩家列表",
      "parameters": { "type": "object", "properties": { "host": { "type": "string" } }, "required": ["host"] }
    }
  ],
  "schedule": []
}
```

校验是 **fail-closed** 的：`id` 必须与目录名一致、`apiVersion` 必须等于本机支持值、`capabilities`
只认白名单、`entry` 必须落在插件目录内（防目录穿越）、`tools[].name` 只许小写字母数字下划线、
`everyMs` 有上下限（1 分钟 ~ 7 天）。任一项不合法 → 拒载并在日志/控制台给出原因，不会静默跳过。

## 协议（apiVersion 1）

一行一个 JSON（NDJSON），宿主与插件共用同一条 stdin/stdout。

**宿主 → 插件**

| 方法 | 说明 |
| --- | --- |
| `init` | 握手：带 `apiVersion`、插件 id、能力清单、该插件自己的配置段 |
| `callTool` | 执行工具：`{ name, args }` |
| `observe` | 一条入站消息（通知，不等回执；只能看，不能改、不能拦） |
| `schedule` | 到点了，执行 manifest 里声明的周期任务 |
| `ping` | 心跳 |
| `shutdown` | 请它自己退出（宽限期内没动静就 kill） |

**插件 → 宿主（能力调用，`cap.` 前缀，按 manifest 声明逐条鉴权）**

| 方法 | 需要声明的能力 |
| --- | --- |
| `cap.log.write` | `log` |
| `cap.storage.get` / `cap.storage.set` | `storage` |
| `cap.config.get` | `config` |
| `cap.http.request` | `http` |

形状最小到能照抄：

```js
// index.mjs —— 一个什么都不做的插件长这样
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let i = buffer.indexOf('\n');
  while (i !== -1) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (line) {
      const m = JSON.parse(line);
      if (m.method === 'init') send({ id: m.id, result: { ok: true } });
      else if (m.method === 'ping') send({ id: m.id, result: {} });
      else if (m.method === 'shutdown') process.exit(0);
      else if (m.method === 'callTool') send({ id: m.id, result: { echo: m.params.args } });
      else if (m.method === 'schedule') send({ id: m.id, result: {} });
    }
    i = buffer.indexOf('\n');
  }
});
```

## 宿主侧纪律（写插件时可以直接依赖的事实）

- 工具名给模型时是 **`<插件id>.<工具名>`**，撞不了名。
- 工具**默认拒**：总开关 `plugins.enabled` 没开、或插件不在 `plugins.enabledIds` 里，它的工具与
  消息投递一律不生效；"加载成功"不等于"被授权"。
- 未声明的能力调用会被拒绝并在日志里留痕（`越权调用 …`），控制台能看到次数。
- 调用有超时（默认 20 秒）；进程崩溃会自动重启，连续崩 3 次后停用（不再空转）；心跳连续两次
  无应答就重启进程。
- 插件的状态走 `cap.storage`（宿主落盘到 `$DATA_DIR/plugin-data/<id>/`，单个值 32KB、
  总量 256KB、每分钟最多写 120 次），进程重启不丢；**卸载插件不会顺手删掉这些数据**。
- 插件不需要写权限：`--allow-fs-write` 一个都不给。

## 配置

```json
{
  "plugins": {
    "enabled": true,
    "enabledIds": ["mc-status"],
    "requireIsolation": true,
    "settings": { "mc-status": { "defaultHost": "play.example.com" } }
  }
}
```

- `enabled` 总开关，默认 `false`；`enabledIds` 是**显式授权清单**，默认空 = 一个都不跑。
- `requireIsolation` 默认 `true`：本机 Node 不支持权限模型时**拒绝加载插件**（没有隔离就不执行
  第三方代码），并在日志与巡检里说明原因。改成 `false` 是明确接受"没有隔离"，后果自负。
- `settings.<id>` 是给单个插件的配置，插件通过 `cap.config.get` 只能读到**自己这一段**。

## 分期

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| v1 第一段 | 目录/manifest/协议/宿主/能力/注册表与门控 + 测试 | **已完成** |
| v1 第二段 | 挂进模型工具表（默认拒）、入站投递、周期任务驱动、巡检与状态出口 | 待做 |
| v1 第三段 | 控制台「插件」页 + 官方索引一键安装（sha256 校验 / 解包防护 / 回滚） | 待做 |
| v1 第四段 | 示例插件（`examples/plugins/mc-status`）、作者向 quickstart、索引模板 | 待做 |
| v1.1 | `send` 能力（出站发言，强制走发送队列与配额）、插件工具按需挂载（工具预算） | 待定 |
| v2 | 插件自带 `node_modules`、索引分级、控制台 UI 扩展 | 待定 |

## 隔离能力实测（Node 22.23.2 / 24）

| 尝试 | 结果 |
| --- | --- |
| 读 `data/config.json`（凭据） | `ERR_ACCESS_DENIED` |
| 读插件目录外的文件 | `ERR_ACCESS_DENIED` |
| `child_process.spawn` / `execSync` | `ERR_ACCESS_DENIED` |
| `worker_threads` | `ERR_ACCESS_DENIED` |
| 写文件（含自己的目录） | `ERR_ACCESS_DENIED` |
| 加载同目录的兄弟模块（多文件插件） | 正常 |
| 网络 | **通**（Node 权限模型里没有网络这一项） |
| `process.env` | 可见 → 由宿主剥掉（白名单只留 PATH/TZ 等） |
