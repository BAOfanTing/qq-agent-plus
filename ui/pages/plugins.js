// 插件页（设置 → 插件）：列表 / 一键安装 / 启停 / 卸载 / 隔离说明。
//
// 与别的设置分区不同：这一页的动作是**点了就生效**（直接打 /api/plugins/*），不走底部那个
// 「保存设置」—— 装/卸/启停插件是运行时动作（要起停子进程、重排工具表），不是配置表单。
// 所以这一页也不参与 saveConfig 的键收集（越界检查见 render-test 的"保存分支"用例）。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { askForConfirmation } from '../core/dom-util.js';

const CAP_LABELS = {
  tools: '给模型加工具',
  observe: '看群消息',
  schedule: '定时跑任务',
  http: '联网（经宿主）',
  log: '写日志',
  storage: '存自己的状态',
  config: '读自己的配置'
};

const STATE_LABELS = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  stopped: '已停止',
  failed: '已停用（连续崩溃）',
  idle: '未启动'
};

const capText = (caps) => (Array.isArray(caps) && caps.length
  ? caps.map((cap) => CAP_LABELS[cap] || cap).join(' · ')
  : '无');

/** 渲染骨架（数据由 bindPluginsSection 填进来：进页面时拉一次，动作完再拉一次）。 */
function renderPluginsSection() {
  return `
    <h3 id="settings-plugins">插件</h3>
    <div class="hint" style="margin-bottom:8px">
      插件让机器人多出一些能力（<b>给模型加工具</b>、<b>看群消息</b>、<b>定时跑任务</b>），
      跑在独立进程里、读不到你的配置（API Key 等）。<b>但插件是第三方代码</b> ——
      装上一个插件等于让它的作者在你的服务器上跑代码，只装你信得过的。
      <br />这一页的改动点了就生效，<b>不用</b>点下面的「保存设置」。
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-plugins-enabled" /><label for="cfg-plugins-enabled">启用插件功能</label></div>
    <div class="hint" style="margin-left:26px" id="plugins-isolation"></div>
    <div class="settings-divider"></div>
    <h3>已安装</h3>
    <div id="plugins-installed"><div class="hint">正在读取…</div></div>
    <div class="settings-divider"></div>
    <h3>官方索引</h3>
    <div class="hint" style="margin-bottom:6px">来自索引地址（在配置里改 <code>plugins.indexUrl</code>）。
      安装后还要<b>在这里点「启用」</b>才会跑 —— 装上 ≠ 授权。</div>
    <div id="plugins-index"><div class="hint">正在读取…</div></div>
    <div class="gm-status" id="plugins-status"></div>`;
}

const statusText = () => $('#plugins-status');

function setStatus(text) {
  const node = statusText();
  if (node) node.textContent = text;
}

/** 目前已装/已授权/索引里的插件，按 id 分组渲染。 */
function renderInstalled(state) {
  const box = $('#plugins-installed');
  if (!box) return;
  if (!state || !Array.isArray(state.plugins) || !state.plugins.length) {
    box.innerHTML = '<div class="hint">还没装任何插件。下面「官方索引」里点「安装」就能装。</div>';
    return;
  }
  const rows = state.plugins.map((item) => {
    const name = item.manifest ? `${esc(item.manifest.name)} <span class="muted">v${esc(item.manifest.version)}</span>` : `<code>${esc(item.id)}</code>`;
    const stateLabel = item.error ? `装不了：${esc(item.error)}`
      : (item.status ? (STATE_LABELS[item.status.state] || item.status.state) : (item.enabled ? '待启动' : '未启用'));
    const detail = item.manifest
      ? `${capText(item.manifest.capabilities)}${item.manifest.tools.length ? ` · 工具 ${item.manifest.tools.length} 个` : ''}`
      : '';
    const err = item.status?.lastError ? `<div class="hint" style="color:#c66">最近错误：${esc(item.status.lastError)}</div>` : '';
    const buttons = [];
    if (item.installed) {
      buttons.push(`<button class="btn btn-small" data-plugin-action="${item.enabled ? 'disable' : 'enable'}" data-plugin-id="${esc(item.id)}">${item.enabled ? '停用' : '启用'}</button>`);
      buttons.push(`<button class="btn btn-small" data-plugin-action="reload" data-plugin-id="${esc(item.id)}">重载</button>`);
      buttons.push(`<button class="btn btn-small" data-plugin-action="uninstall" data-plugin-id="${esc(item.id)}">卸载</button>`);
    }
    return `<tr>
      <td>${name}<div class="hint">${esc(detail)}</div>${err}</td>
      <td class="muted">${stateLabel}</td>
      <td>${buttons.join(' ')}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="table-wrap"><table class="usage-table"><thead><tr><th>插件</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderIndex(list, installed) {
  const box = $('#plugins-index');
  if (!box) return;
  if (!Array.isArray(list) || !list.length) {
    box.innerHTML = '<div class="hint">索引为空或还没拉到（索引地址没配、或网络不通时看「状态」那行）。</div>';
    return;
  }
  const have = new Set((installed?.plugins || []).filter((p) => p.installed).map((p) => p.id));
  const rows = list.map((item) => {
    const action = have.has(item.id)
      ? '<span class="muted">已安装</span>'
      : `<button class="btn btn-small" data-plugin-action="install" data-plugin-id="${esc(item.id)}">安装</button>`;
    return `<tr>
      <td><b>${esc(item.name)}</b> <span class="muted">v${esc(item.version)}</span><div class="hint">${esc(item.description)}</div>
        <div class="hint">权限：${esc(capText(item.capabilities))}</div></td>
      <td>${action}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="table-wrap"><table class="usage-table"><thead><tr><th>可用插件</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** 进页面时拉一次；每个动作做完再拉一次（状态都会变）。 */
async function refreshPlugins() {
  try {
    const state = await api('/api/plugins');
    const enabledBox = $('#cfg-plugins-enabled');
    if (enabledBox) enabledBox.checked = state?.enabled === true;
    const iso = $('#plugins-isolation');
    if (iso) {
      const isolation = state?.isolation || {};
      iso.textContent = isolation.supported
        ? '本机支持进程隔离：插件读不到配置文件、起不了子进程、写不了文件；但它拦不住网络（Node 权限模型不管网络），所以它看到的内容可能被外发。'
        : '⚠️ 本机 Node 不支持权限隔离 —— 插件不会被加载（除非在配置里明确关掉 plugins.requireIsolation）。';
    }
    renderInstalled(state);
    let list = [];
    try {
      const indexResult = await api('/api/plugins/index');
      list = indexResult?.plugins || [];
    } catch (error) {
      setStatus(`索引拉取失败：${error?.message || error}`);
    }
    renderIndex(list, state);
    return state;
  } catch (error) {
    setStatus(`读取插件状态失败：${error?.message || error}`);
    renderInstalled(null);
    return null;
  }
}

async function post(path, body) {
  return api(path, { method: 'POST', body: JSON.stringify(body) });
}

let delegationBound = false;

/** 绑定这一页的控件（渲染后调用一次；按钮走事件委托，刷新表格不用重绑）。 */
function bindPluginsSection() {
  // 总开关那个复选框每次渲染都重建 → 每次都要绑（旧节点连同监听一起被丢弃）
  $('#cfg-plugins-enabled')?.addEventListener('change', async (event) => {
    const enabled = event.currentTarget.checked;
    try {
      await post('/api/plugins/master', { enabled });
      setStatus(enabled ? '已启用插件功能' : '已关闭插件功能');
    } catch (error) {
      event.currentTarget.checked = !enabled;
      setStatus(`切换失败：${error?.message || error}`);
    }
    await refreshPlugins();
  });

  // ⚠️ 委托挂在 #settings-form 上，而那个元素是**长期存在**的（渲染只换 innerHTML）：
  // 每次渲染都重绑会叠监听 → 一次点击发两次请求（同类问题见人物记忆页那次复审）。
  if (delegationBound) return;
  delegationBound = true;
  $('#settings-form')?.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-plugin-action]');
    if (!button || !$('#settings-plugins')) return;   // 只在插件页生效
    const action = button.dataset.pluginAction;
    const id = button.dataset.pluginId || '';
    if (action === 'uninstall') {
      const ok = await askForConfirmation(`确定卸载插件「${id}」？代码会被移走（插件自己的数据保留，重装后还在）。`);
      if (!ok) return;
      button.disabled = true;
      try {
        await post('/api/plugins/uninstall', { id, confirm: true });
        setStatus(`已卸载 ${id}`);
      } catch (error) { setStatus(`卸载失败：${error?.message || error}`); }
      await refreshPlugins();
      return;
    }
    button.disabled = true;
    try {
      if (action === 'install') {
        setStatus(`正在安装 ${id}…`);
        await post('/api/plugins/install', { id });
        setStatus(`已安装 ${id} —— 还要点「启用」才会跑（装上 ≠ 授权）`);
      } else if (action === 'enable' || action === 'disable') {
        await post('/api/plugins/toggle', { id, enabled: action === 'enable' });
        setStatus(`${action === 'enable' ? '已启用' : '已停用'} ${id}`);
      } else if (action === 'reload') {
        await post('/api/plugins/reload', { id });
        setStatus(`已重载 ${id}`);
      }
    } catch (error) {
      setStatus(`操作失败：${error?.message || error}`);
    }
    await refreshPlugins();
  });
}

/** 进这一页时把两张表填上（渲染完由 bindPluginsSection 调用）。 */
function loadPluginsSection() {
  return refreshPlugins();
}

// 导出统一放末尾（本仓 ui/ 的约定：test/ui-module-graph.test.mjs 按 ExportNamedDeclaration 的
// specifiers 收集名字，而 export function 那种写法没有 specifiers，它收不到）
export { renderPluginsSection, refreshPlugins, bindPluginsSection, loadPluginsSection };
