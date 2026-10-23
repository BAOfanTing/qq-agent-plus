// 常用 MCP server 预设：离线可用，避免依赖官方 Registry 的网络可达性。
// 命令与参数来自官方参考 server / 常见发行包；导入后仍需管理员确认目录、令牌和信任。

const preset = (id, title, description, command, args, env = {}) => ({
  id,
  title,
  name: id,
  description,
  version: '',
  repository: '',
  unsupported: false,
  config: {
    id,
    enabled: false,
    transport: 'stdio',
    command,
    args,
    env,
    timeoutMs: 30000,
    maxCallsPerMinute: 30,
    toolMounting: 'direct'
  }
});

export const MCP_PRESETS = [
  preset(
    'filesystem',
    'Filesystem',
    '读写指定目录。导入后把 /data 改成你允许它访问的目录（不要给根目录/密钥目录）。',
    'npx',
    ['-y', '@modelcontextprotocol/server-filesystem', '/data']
  ),
  preset(
    'memory',
    'Memory',
    '一个简单的知识图谱记忆 server，适合跨会话保存结构化笔记。',
    'npx',
    ['-y', '@modelcontextprotocol/server-memory']
  ),
  preset(
    'git',
    'Git',
    '查询本地 git 仓库（日志、diff、状态）。导入后把 /path/to/repo 改成仓库路径。',
    'uvx',
    ['mcp-server-git', '--repository', '/path/to/repo']
  ),
  preset(
    'github',
    'GitHub',
    '读写 GitHub issue/PR/仓库。需要 GITHUB_PERSONAL_ACCESS_TOKEN。',
    'npx',
    ['-y', '@modelcontextprotocol/server-github'],
    { GITHUB_PERSONAL_ACCESS_TOKEN: '' }
  ),
  preset(
    'everything',
    'Everything',
    '官方参考实现，包含多种示例工具，适合先验证 MCP 接入是否正常。',
    'npx',
    ['-y', '@modelcontextprotocol/server-everything']
  ),
  preset(
    'sequential-thinking',
    'Sequential Thinking',
    '把复杂问题拆成可回溯的思考步骤，适合规划和推理。',
    'npx',
    ['-y', '@modelcontextprotocol/server-sequential-thinking']
  ),
  preset(
    'fetch',
    'Fetch',
    '抓取网页并转成 markdown，适合给模型读文章。需要本机有 uv/uvx。',
    'uvx',
    ['mcp-server-fetch']
  ),
  preset(
    'time',
    'Time',
    '时区/时间换算。需要本机有 uv/uvx。',
    'uvx',
    ['mcp-server-time']
  ),
  preset(
    'playwright',
    'Playwright',
    '浏览器自动化：打开网页、点击、抓页面。首次运行可能需要安装浏览器。',
    'npx',
    ['-y', '@playwright/mcp@latest']
  ),
  preset(
    'brave-search',
    'Brave Search',
    '网页搜索。需要 BRAVE_API_KEY。',
    'npx',
    ['-y', '@brave/brave-search-mcp-server'],
    { BRAVE_API_KEY: '' }
  )
];

export function searchPresets(query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return MCP_PRESETS;
  return MCP_PRESETS.filter((item) =>
    [item.id, item.title, item.description].some((value) => String(value).toLowerCase().includes(q)));
}
