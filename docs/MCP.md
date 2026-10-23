# MCP：把外部 MCP Server 的工具接进模型

MCP（Model Context Protocol）是一个标准客户端/服务端协议。本项目的 MCP 客户端用 **stdio** 启动外部 server，把 `tools/list` 里的工具接进模型，调用时走 `tools/call`。

默认关闭。配置在 `config.json`：

```json
{
  "mcp": {
    "enabled": true,
    "servers": [
      {
        "id": "files",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data/knowledge"],
        "env": {},
        "timeoutMs": 30000,
        "maxCallsPerMinute": 30,
        "toolMounting": "direct"
      }
    ]
  }
}
```

## 字段

- `id`：唯一标识，会出现在工具名 `mcp_<id>_<tool>` 和提示词里；只保留字母数字/下划线/短横。
- `command` / `args` / `env` / `cwd`：启动方式。**等价于执行本机命令**，只填你信任的 server。
- `timeoutMs`：单次 JSON-RPC 请求超时，默认 30 秒。
- `maxCallsPerMinute`：每个 server 每分钟最多调用次数，默认 30。
- `toolMounting`：
  - `direct`：每个工具各挂一个定义，模型直接看到工具名；
  - `meta`：只挂一个 `mcp_call`，参数里选 server/tool，适合工具多、想省提示词。
- `enabled`（server 级）：单独停某个 server。

## 安全

MCP server 是第三方代码，能读你给它的目录、能访问网络（取决于它自己）。本项目只做三件事：

1. 配置里显式写了才启动，默认不启用；
2. 每个 server 有超时和每分钟调用上限；
3. 工具调用失败/超限只回给模型，不记进异常面板。

不做沙箱：MCP server 以当前用户权限运行。不要给它宿主机根目录、配置文件或密钥目录。需要联网的工具，优先选官方/可信 server。

## 控制台与运维

- `GET /api/mcp`：查看每个 server 是否就绪、工具列表、错误；
- `POST /api/mcp/reload`：配置改了之后重载（会停掉旧进程再起）；
- 改 `config.json` 里的 `mcp` 段后，调一次 reload 即可，不用重启整个服务。

## 和插件、RAG 的区别

- **MCP**：标准外部工具，接一个 server 就多一批工具；适合文件、数据库、浏览器、GitHub、内部 API。
- **插件**：跑在本项目子进程里的第三方扩展，能看群消息、发消息、定时任务；适合 QQ 特有逻辑。
- **RAG**：从文档里检索答案；MCP 的 filesystem server 只能读文件，不等于 RAG。

MCP 不会让人设更像真人，它扩展的是“能做什么”。
