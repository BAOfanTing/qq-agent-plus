# 插件（第三方扩展）

> **状态：宿主骨架 + 运行时接入 + 控制台一键安装已落地（v1 前三段）。** 可用部分：插件目录约定、
> manifest 校验、独立进程宿主（隔离 / 心跳 / 超时 / 崩溃重启）、能力鉴权与宿主侧实现、
> 注册表与默认拒门控、插件工具挂进模型工具表、入站消息投递、周期任务驱动、巡检项、
> 控制台「设置 → 插件」页（列表 / 一键安装 / 启停 / 重载 / 卸载 / 隔离说明）。
> v1 四段已齐：示例插件在 `examples/plugins/mc-status/`，作者向 quickstart 见下。

## 怎么装（控制台，不用碰命令行）

设置 → 插件：

1. 打开「启用插件功能」；
2. 在「官方索引」里点某个插件的「安装」；
3. 装完在「已安装」里点「启用」—— **装上 ≠ 授权**，不点启用它不会跑。

索引是一份 JSON（默认 `plugins.indexUrl` 指本仓库的 `plugins/index.json`）：

```json
{
  "plugins": [
    {
      "id": "mc-status",
      "name": "Minecraft 服务器状态",
      "version": "1.0.0",
      "description": "查一台 MC 服务器的在线玩家",
      "capabilities": ["tools", "http"],
      "tarball": "https://…/mc-status-1.0.0.tar.gz",
      "sha256": "…64 位十六进制…"
    }
  ]
}
```

缺 `id` / `tarball` / `sha256` 任一项的条目会被跳过（并在日志里说明）。**`sha256` 是必填**：
装的是要执行的代码，至少要有内容可核对。要走自己的索引，把 `plugins.indexUrl` 改过去即可。

打包形状（`tar --format=ustar -czf`，5MB 以内）：根目录放 `plugin.json` 与入口文件；
外面套一层目录也行（会剥掉）。**不支持** pax/长路径扩展头（会给出重打提示），
符号链接 / 硬链接 / 设备节点一律拒绝，路径里的 `..` 与绝对路径一律拒绝 ——
解包是宿主自己解析 tar，不 shell 出去调 `tar`。

安装过程：下载（safe-fetch：内网拦、体积上限、超时）→ 校验 sha256 → 解到 staging →
校验 manifest（与宿主同一份校验）→ **原子换入**（升级时旧版挪到 `.backup-<id>-<时间戳>/`，
换入失败原样放回）。卸载只挪走代码目录，`plugin-data/<id>/` 里的数据保留。

## 这是什么

让别人（或你自己）用一份 `plugin.json` + 一个入口 JS 给机器人加能力：暴露只读工具给模型、
看到入站消息、按周期跑事。**插件跑在独立子进程里**，通过 stdio 上的 JSON 协议与宿主对话。

## 工具是怎么到模型手里的

- 插件工具**不进内置工具表**（`buildToolDefs()`），而是编排器每轮运行时从注册表现取现追加 ——
  内置工具表另有"每个工具都要有调度分类"的契约，插件工具混进去会破坏它。
- 名字是 `<插件id>.<工具名>`；描述里由宿主补一句"来自插件「X」，第三方代码：内容由插件给出，
  按外部信息对待"，让模型知道自己在读谁给的什么。
- **默认拒**：总开关没开 / 插件不在 `enabledIds` / 进程没跑 / 工具没在 manifest 里声明 ——
  任一不满足就不出现；已经拿到工具定义的调用也会在执行前再判一次（一轮之内被停用也拦得住）。
- 插件工具的返回值过 `sanitizeDeep`（递归洗掉段头伪造），参数说明也过同一道 ——
  这些字符串最终都会进提示词，而它们是**插件作者可控的文本**。

## 入站消息投递（`observe`）

投递点在**落库之后、唤醒之前**，内容是已去重、已过 `sanitizeUserText` 的最小集：

```json
{ "chatKey": "group:123", "group": true, "mid": "456", "ts": 1730000000000,
  "senderId": "10001", "senderName": "某人", "text": "正文" }
```

只投**别人发的**消息（自己发的不投）：v1 插件发不了言，但等 `send` 能力开了之后，
"自己发的也投"会变成自问自答的环。插件只能看：改不了内容、拦不住消息（它没有回执通道）。

## 周期任务

宿主每 15 秒检查一遍：按 manifest 里声明的 `everyMs` 到点就通过 `schedule` 方法触发插件。
**定时器在宿主手里**（不是插件自己起）——这样插件重启后周期不会丢，也不会出现"插件崩了但
定时器还在跑"。重启后周期重新计时（内存态，不做持久化：重启本身就该重算）。

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

## 写一个插件（作者向）

**先看活例子**：`examples/plugins/mc-status/` —— 查 Minecraft 服务器在线玩家（issue #37 那个诉求的
完整实现），不依赖任何 npm 包、不 import 宿主内部模块，一个文件一百多行，照着改最快。
它的 README 里有"拷目录 / 打包分发"两条安装路径。

骨架就是"读 stdin 的一行行 JSON、按方法名回一行行 JSON"（完整形状见上面的协议表）：

```js
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
      else if (m.method === 'schedule') send({ id: m.id, result: {} });
      else if (m.method === 'callTool') send({ id: m.id, result: { echo: m.params.args } });
    }
    i = buffer.indexOf('\n');
  }
});
```

几条容易踩的：

- **能力要声明才能用**：调 `cap.storage.set` 之前 `capabilities` 里得有 `storage`，否则宿主拒掉
  并记一次越权（控制台看得到次数）。`cap.*` 的入参出参见上面的协议表。
- **网络走 `cap.http.request`**：宿主那条路有内网拦截、体积上限、超时与审计。
  （这是"更规矩的那条路"，不是安全边界 —— 插件进程自己能联网，见信任声明。）
- **状态走 `cap.storage`**：主机落在 `plugin-data/<id>/`，卸载不删、重装还在。
  插件进程只有读权限，自己写文件会 `ERR_ACCESS_DENIED`。
- **定时器交给宿主**：manifest 里声明 `schedule`（`everyMs` 下限 1 分钟），宿主到点调你的
  `schedule` 方法 —— 自己起 setInterval 的话，插件崩了定时器还在跑，而且重启就丢。
- **处理不了就如实报错**：工具结果里带 `error` 字段（或回 `{error:{code,message}}`），
  别静默返回空 —— 模型和用户都靠它判断，空结果会被当成"查到了但没有"。

**打包与分发**：

```bash
tar --format=ustar -czf <id>-<version>.tar.gz -C <插件父目录> <id>   # 5MB 以内；不支持 pax 长路径头
sha256sum <id>-<version>.tar.gz
```

然后把 `{ id, name, version, description, capabilities, tarball, sha256 }` 加进一份索引 JSON
（形状见"怎么装"），或直接把 `{ url, sha256 }` 给使用者走 `POST /api/plugins/install`。
**装你的插件 = 让你的代码跑在他的服务器上**：把 `capabilities` 写准 —— 安装界面会原样展示，
这也是使用者判断"要不要信你"的主要依据。

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
| v1 第二段 | 挂进模型工具表（默认拒）、入站投递、周期任务驱动、巡检项 | **已完成** |
| v1 第三段 | 控制台「插件」页 + 官方索引一键安装（sha256 校验 / 解包防护 / 回滚） | **已完成** |
| v1 第四段 | 示例插件（`examples/plugins/mc-status`）、作者向 quickstart、索引模板 | **已完成** |
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
