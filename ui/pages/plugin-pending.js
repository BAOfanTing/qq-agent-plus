// 插件待批的全局入口：侧栏徽标 + 插件页顶部汇总条。
// 从 plugins.js 拆出来，避免那个文件突破 1800 行；只依赖 api/dom，不反向 import 插件页。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';

const JUMP_KEY = 'qa-plugin-pending-jump';

/** 全局待批红点：侧栏「插件」按钮上的未批请求计数（跨插件汇总，审批是全局状态）。 */
async function refreshPendingBadge() {
  try {
    const data = await api('/api/plugins/pending-count');
    const n = Number(data?.count) || 0;
    document.querySelectorAll('[data-pending-badge]').forEach((node) => {
      node.textContent = n > 99 ? '99+' : String(n);
      node.style.display = n > 0 ? '' : 'none';
      node.setAttribute('aria-label', n > 0 ? `有 ${n} 条插件待批` : '没有插件待批');
      node.setAttribute('title', n > 0 ? `${n} 条插件待批，点击查看` : '');
    });
  } catch { /* 计数失败不影响页面 */ }
}

/** B 站写操作的目标（BV/av 号）变成可点击链接；其它目标原样显示。 */
function pendingTargetHref(target) {
  const t = String(target || '').trim();
  if (/^BV[0-9A-Za-z]{5,}$/.test(t)) return `https://www.bilibili.com/video/${t}`;
  if (/^av\d+$/i.test(t)) return `https://www.bilibili.com/video/${t.toLowerCase()}`;
  return '';
}

/** 插件页顶部的全量待批条；返回列表供调用方复用（失败返回空数组，不影响页面）。 */
async function loadPendingBanner() {
  const box = $('#plugins-pending-banner');
  if (!box) return [];
  try {
    const data = await api('/api/plugins/pending');
    const list = Array.isArray(data?.pending) ? data.pending : [];
    if (!list.length) {
      box.hidden = true;
      box.innerHTML = '';
      return [];
    }
    const now = Date.now();
    const rows = list.slice(0, 6).map((item) => {
      const mins = Math.max(1, Math.round((Number(item.expiresAt) - now) / 60000));
      const warn = item.notify?.ok === false ? '<i class="ppb-warn">通知未送达</i>' : '';
      return `<button type="button" class="ppb-row" data-plugin-open="${esc(item.pluginId)}" data-pending-jump="1">
        <strong>${esc(item.pluginName)}</strong>
        <span>${esc(item.label)}${item.target ? ` → ${esc(item.target)}` : ''}</span>
        <em>剩 ${mins} 分</em>${warn}
      </button>`;
    }).join('');
    box.hidden = false;
    box.innerHTML = `<div class="ppb-head"><b>${list.length} 条待批</b>
      <span>点击进入对应插件，在「待你批准」里处理</span></div>
      <div class="ppb-rows">${rows}</div>
      ${list.length > 6 ? `<div class="ppb-more">还有 ${list.length - 6} 条，进入插件页查看</div>` : ''}`;
    // 从侧栏徽标点进来：自动打开第一条待批所在插件（click 由 plugins.js 的委托处理）
    let jump = false;
    try {
      jump = sessionStorage.getItem(JUMP_KEY) === '1';
      sessionStorage.removeItem(JUMP_KEY);
    } catch { /* 隐私模式禁 storage：只少一次自动跳转 */ }
    if (jump) document.querySelector('[data-pending-jump]')?.click();
    return list;
  } catch {
    box.hidden = true;
    return [];
  }
}

export { refreshPendingBadge, loadPendingBanner, pendingTargetHref };
