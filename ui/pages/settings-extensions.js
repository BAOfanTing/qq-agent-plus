// 平台扩展设置：MCP / 轻量知识库 / 群管理。
// 这些开关与 server 列表都是管理员级配置；保存走 settings-save.js 的统一 saveConfig。

import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';

function mcpServerRowHtml(server = {}) {
  const id = esc(server.id || '');
  const args = esc(JSON.stringify(Array.isArray(server.args) ? server.args : []));
  const env = esc(JSON.stringify(server.env && typeof server.env === 'object' ? server.env : {}));
  const mounting = String(server.toolMounting || 'direct');
  return `
    <div class="mcp-server">
      <div class="field-row">
        <div class="field"><label>ID</label><input class="mcp-id" type="text" value="${id}" placeholder="files" /></div>
        <div class="field"><label>命令</label><input class="mcp-command" type="text" value="${esc(server.command || '')}" placeholder="npx" /></div>
        <div class="field"><label>超时（毫秒）</label><input class="mcp-timeout" type="number" min="1000" max="300000" value="${esc(server.timeoutMs ?? 30000)}" /></div>
        <div class="field"><label>每分钟上限</label><input class="mcp-maxcalls" type="number" min="1" max="600" value="${esc(server.maxCallsPerMinute ?? 30)}" /></div>
      </div>
      <div class="field"><label>参数（JSON 数组）</label><input class="mcp-args" type="text" value="${args}" placeholder='["-y","@modelcontextprotocol/server-filesystem","/data"]' /></div>
      <div class="field"><label>环境变量（JSON 对象，可留空）</label><input class="mcp-env" type="text" value="${env}" placeholder='{"TOKEN":"..."}' /></div>
      <div class="field-row">
        <div class="field"><label>挂载方式</label><select class="mcp-mounting">
          <option value="direct" ${mounting === 'direct' ? 'selected' : ''}>direct（每个工具一个定义）</option>
          <option value="meta" ${mounting === 'meta' ? 'selected' : ''}>meta（只挂 mcp_call）</option>
        </select></div>
        <div class="field"><label><input class="mcp-enabled" type="checkbox" ${server.enabled !== false ? 'checked' : ''} /> 启用这个 server</label></div>
        <div class="field"><button type="button" class="btn btn-danger btn-small mcp-remove">删除</button></div>
      </div>
    </div>`;
}

function renderMcpSection(c) {
  const mcp = c.mcp || {};
  const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
  return `
    <h3 id="settings-mcp">MCP 工具</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mcp-enabled" ${mcp.enabled === true ? 'checked' : ''} />
      <label for="cfg-mcp-enabled">启用 MCP（外部 MCP Server 的工具会接进模型）</label></div>
    <div class="hint">MCP Server 等价于执行本机命令，只填你信任的 server。保存后点「重新加载」生效；命令与参数只在本页显示，不回传密钥。</div>
    <div id="mcp-servers">${servers.map((server) => mcpServerRowHtml(server)).join('')}</div>
    <div class="settings-inline-actions">
      <button type="button" class="btn btn-small" id="mcp-add-server">＋ 添加 server</button>
      <button type="button" class="btn btn-small" id="mcp-reload">重新加载</button>
      <span class="muted" id="mcp-reload-result"></span>
    </div>
    <div class="field"><label>运行状态</label><div class="hint" id="mcp-status">读取中…</div></div>`;
}

function renderKnowledgeSection(c) {
  const k = c.knowledge || {};
  return `
    <h3 id="settings-knowledge">轻量知识库</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-knowledge-enabled" ${k.enabled === true ? 'checked' : ''} />
      <label for="cfg-knowledge-enabled">启用本地知识库（只读 .md / .txt，不接 embedding）</label></div>
    <div class="field-row">
      <div class="field"><label>目录（留空 = data/knowledge）</label><input type="text" id="cfg-knowledge-dir" value="${esc(k.dir || '')}" placeholder="data/knowledge" /></div>
      <div class="field"><label>最多返回片段</label><input type="number" id="cfg-knowledge-maxresults" min="1" max="10" value="${esc(k.maxResults ?? 4)}" /></div>
      <div class="field"><label>切片大小（字符）</label><input type="number" id="cfg-knowledge-chunk" min="200" max="4000" value="${esc(k.chunkChars ?? 900)}" /></div>
      <div class="field"><label>切片重叠（字符）</label><input type="number" id="cfg-knowledge-overlap" min="0" max="2000" value="${esc(k.overlapChars ?? 120)}" /></div>
    </div>
    <div class="hint">把群规/FAQ/手册放进这个目录，保存后模型可通过 knowledge_search 检索并带来源回答。不是完整 RAG：没有向量检索、没有 PDF/DOCX 解析。</div>
    <div class="field"><label>索引状态</label><div class="hint" id="knowledge-status">读取中…</div></div>`;
}

function renderModerationSection(c) {
  const enabled = c.moderation?.enabled !== false;
  return `
    <h3 id="settings-moderation">群管理</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-moderation-enabled" ${enabled ? 'checked' : ''} />
      <label for="cfg-moderation-enabled">允许群管理工具（禁言 / 踢人 / 撤回 / 设置管理员）</label></div>
    <div class="hint">
      只对全局管理员开放，而且必须是本批次最后一条发言；不能对自己或管理员执行。
      关掉后这四个工具会从模型工具表里摘除，模型看不到也不会调用。
    </div>`;
}

async function reloadMcp() {
  try {
    await api('/api/mcp/reload', { method: 'POST', body: JSON.stringify({}) });
  } catch { /* 状态会显示失败原因 */ }
  await hydrateExtensionStatus();
}

function bindExtensionSettings() {
  const add = $('#mcp-add-server');
  const box = $('#mcp-servers');
  if (add && box) {
    add.addEventListener('click', () => {
      const count = box.querySelectorAll('.mcp-server').length + 1;
      box.insertAdjacentHTML('beforeend', mcpServerRowHtml({
        id: `server${count}`,
        enabled: true,
        command: '',
        args: [],
        env: {},
        timeoutMs: 30000,
        maxCallsPerMinute: 30,
        toolMounting: 'direct'
      }));
    });
  }
  if (box) {
    box.addEventListener('click', (event) => {
      const button = event.target.closest('.mcp-remove');
      if (button) button.closest('.mcp-server')?.remove();
    });
  }
  const reload = $('#mcp-reload');
  if (reload) {
    reload.addEventListener('click', async () => {
      const result = $('#mcp-reload-result');
      reload.disabled = true;
      if (result) result.textContent = '正在重载…';
      await reloadMcp();
      if (result) result.textContent = '已重载';
      reload.disabled = false;
    });
  }
}

async function hydrateExtensionStatus() {
  const mcpBox = $('#mcp-status');
  if (mcpBox) {
    try {
      const data = await api('/api/mcp');
      const rows = Array.isArray(data.status) ? data.status : [];
      if (!rows.length) mcpBox.textContent = '未配置或未启用 MCP server';
      else {
        mcpBox.innerHTML = rows.map((row) => {
          const stateText = row.ready ? '就绪' : row.starting ? '启动中' : '未就绪';
          const tools = row.tools?.length ? ` · 工具：${row.tools.join(', ')}` : '';
          const err = row.error ? ` · ${row.error}` : '';
          return `<div>${esc(row.id)}：${stateText}${esc(tools)}${esc(err)}</div>`;
        }).join('');
      }
    } catch (error) {
      mcpBox.textContent = `读取失败：${error.message}`;
    }
  }
  const kbBox = $('#knowledge-status');
  if (kbBox) {
    try {
      const data = await api('/api/knowledge');
      kbBox.textContent = data.enabled
        ? `${data.available ? '已索引' : '目录不存在'}：${data.files || 0} 个文件，${data.chunks || 0} 个片段 · ${data.dir || ''}`
        : '未启用';
    } catch (error) {
      kbBox.textContent = `读取失败：${error.message}`;
    }
  }
}

export { bindExtensionSettings, hydrateExtensionStatus, reloadMcp, renderKnowledgeSection, renderMcpSection, renderModerationSection };
