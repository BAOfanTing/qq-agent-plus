// 会话多选（群 / 私聊）的统一选择器。
//
// 之前各设置页把"全部群"摊成一排复选框塞进 168px 的滚动框：群少时两块并排高度对不齐
// （左列空一大块），群/好友上百时只能靠滚动条硬翻。现在页面里只留一行「已选摘要 + 选择」
// 按钮，点开是带搜索、类型页签、只看已选、全选/清空、计数的弹窗，条目再多也不会撑高设置页。
//
// 保存语义：只有真正点过「确定」的字段才进保存补丁（容器 dataset 上的 sessionDirty），
// 没打开过的字段一律不写——不会因为"列表还没拉回来"把存量配置覆盖成空。清空也必须在
// 弹窗里点「清空 + 确定」，不会因为顺手保存一次别的设置就把名单清掉。
import { api } from './api.js';
import { esc } from './dom.js';

const PICKER_KIND_LABEL = { group: '群', private: '私聊' };
const PICKER_CACHE_TTL_MS = 60000;
const pickerCache = { groups: null, groupsAt: 0, friends: null, friendsAt: 0 };

function pickerParseKeys(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickerKindOf(key) {
  return String(key).startsWith('private:') ? 'private' : 'group';
}

function pickerIdOf(key) {
  const text = String(key || '');
  const index = text.indexOf(':');
  return index >= 0 ? text.slice(index + 1) : text;
}

// 老配置里可能存裸群号（手写 config.json / 旧版本）：渲染前统一补成 group:<群号>，
// 否则弹窗里会同时出现"未勾选的正常行"和"不在列表"的 stale 行，两行都勾会存出重复项。
function pickerChatKey(entry) {
  const raw = String(entry || '').trim();
  if (!raw) return '';
  if (/^(group|private):\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `group:${raw}`;
  return raw;
}

function pickerSummaryOf(keys) {
  if (!keys.length) return '';
  const groups = keys.filter((key) => pickerKindOf(key) === 'group').length;
  const privates = keys.length - groups;
  const detail = [groups ? `${groups} 群` : '', privates ? `${privates} 私聊` : ''].filter(Boolean).join(' / ');
  return `已选 ${keys.length} 个 · ${detail}`;
}

// 群/好友列表缓存在模块里 60 秒：同一次设置页渲染里两个字段、以及反复开关弹窗都不重复请求。
// 拉取失败不写缓存，下次打开会重试。
async function pickerCachedList(path, field, atField) {
  if (pickerCache[field] && Date.now() - pickerCache[atField] < PICKER_CACHE_TTL_MS) {
    return { list: pickerCache[field], failed: false };
  }
  try {
    const data = await api(path);
    const list = Array.isArray(data?.[field]) ? data[field] : [];
    pickerCache[field] = list;
    pickerCache[atField] = Date.now();
    return { list, failed: false };
  } catch {
    return { list: [], failed: true };
  }
}

async function pickerLoadSessions(allowFriends) {
  const [groups, friends] = await Promise.all([
    pickerCachedList('/api/onebot/groups', 'groups', 'groupsAt'),
    allowFriends ? pickerCachedList('/api/onebot/friends', 'friends', 'friendsAt') : Promise.resolve({ list: [], failed: false })
  ]);
  return {
    groups: groups.list,
    friends: friends.list,
    groupsFailed: groups.failed,
    friendsFailed: allowFriends && friends.failed
  };
}

function pickerBuildItems({ groups, friends, selected }) {
  const items = [];
  const seen = new Set();
  for (const group of groups) {
    const key = `group:${group.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, kind: 'group', name: String(group.name ?? ''), id: String(group.id), stale: false });
  }
  for (const friend of friends) {
    const key = `private:${friend.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, kind: 'private', name: String(friend.name ?? ''), id: String(friend.id), stale: false });
  }
  // 配置里有、但当前拉不到（退群/改名/协议端未连接）的也列出来，否则一次保存就把它静默丢掉。
  for (const key of selected) {
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, kind: pickerKindOf(key), name: key, id: '', stale: true });
  }
  return items;
}

/**
 * 打开会话选择弹窗。
 * @returns {Promise<string[]|null>} 确定时返回选中的 key 列表；取消/关闭返回 null。
 */
function openSessionPicker({ title = '选择会话', allowFriends = true, selected = [] } = {}) {
  const chosen = new Set(selected);
  const state = { tab: 'all', query: '', onlySelected: false };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal session-picker-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">${esc(title)}</div>
      <div class="session-picker-toolbar">
        <input type="search" class="session-picker-search" placeholder="搜索名称或号码" />
        ${allowFriends ? `<div class="session-picker-tabs" role="tablist">
          <button type="button" class="session-picker-tab is-on" data-tab="all" aria-pressed="true">全部</button>
          <button type="button" class="session-picker-tab" data-tab="group" aria-pressed="false">群聊</button>
          <button type="button" class="session-picker-tab" data-tab="private" aria-pressed="false">私聊</button>
        </div>` : ''}
        <label class="checkbox-row session-picker-only"><input type="checkbox" class="session-picker-only-box" /> <span>只看已选</span></label>
      </div>
      <div class="session-picker-bulk">
        <button type="button" class="btn btn-small session-picker-all">全选</button>
        <button type="button" class="btn btn-small session-picker-none">清空</button>
        <span class="session-picker-tip muted"></span>
      </div>
      <div class="modal-list session-picker-list"><div class="session-picker-empty muted">正在读取会话列表…</div></div>
      <div class="modal-foot">
        <span class="session-picker-total muted"></span>
        <button type="button" class="btn btn-small session-picker-cancel">取消</button>
        <button type="button" class="btn btn-primary btn-small session-picker-ok">确定</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector('.session-picker-list');
  const searchEl = overlay.querySelector('.session-picker-search');
  const onlyEl = overlay.querySelector('.session-picker-only-box');
  const tipEl = overlay.querySelector('.session-picker-tip');
  const totalEl = overlay.querySelector('.session-picker-total');
  let items = [];
  let loading = true;
  let groupsFailed = false;
  let friendsFailed = false;

  const close = (result) => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    resolve(result);
  };
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const onKey = (event) => { if (event.key === 'Escape') close(null); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(null); });
  overlay.querySelector('.session-picker-cancel').addEventListener('click', () => close(null));
  overlay.querySelector('.session-picker-ok').addEventListener('click', () => close([...chosen]));

  const visibleItems = () => items.filter((item) => {
    if (state.tab !== 'all' && item.kind !== state.tab) return false;
    if (state.onlySelected && !chosen.has(item.key)) return false;
    if (!state.query) return true;
    const haystack = `${item.name} ${item.id} ${PICKER_KIND_LABEL[item.kind]}`.toLowerCase();
    return haystack.includes(state.query);
  });

  const rowHtml = (item) => '<label class="session-picker-row">'
    + `<input type="checkbox" class="session-pick" value="${esc(item.key)}"${chosen.has(item.key) ? ' checked' : ''} />`
    + `<span class="session-picker-kind">${PICKER_KIND_LABEL[item.kind]}</span>`
    + `<span class="session-picker-name" title="${esc(item.name || item.id)}">${esc(item.name || item.id)}</span>`
    + (item.stale
      ? '<span class="session-picker-stale">不在当前列表</span>'
      : `<span class="session-picker-id">${esc(item.id)}</span>`)
    + '</label>';

  // 拉取失败要能看出"是没有，还是读不到"：好友接口在老协议端会 502，
  // 只显示"没有匹配的会话"会让人以为私聊全没了。
  const failureNotes = () => {
    const notes = [];
    if (state.tab !== 'private' && groupsFailed) notes.push('群列表读取失败');
    if (state.tab !== 'group' && allowFriends && friendsFailed) notes.push('好友列表读取失败（协议端可能不支持 get_friend_list）');
    return notes;
  };
  // tip 与空态用同一份失败信息：勾选一行后只重拼 tip，失败标记不能凭空消失。
  const tipText = (visibleCount) => `当前列表 ${visibleCount} / ${items.length}`
    + (groupsFailed ? ' · 群读取失败' : '')
    + (friendsFailed ? ' · 好友读取失败' : '');
  const render = () => {
    const visible = visibleItems();
    if (loading) {
      listEl.innerHTML = '<div class="session-picker-empty muted">正在读取会话列表…</div>';
      if (tipEl) tipEl.textContent = '';
    } else {
      const notes = failureNotes();
      const emptyText = items.length ? '没有匹配的会话' : '拿不到会话列表（协议端未连接或接口不可用）';
      listEl.innerHTML = visible.length
        ? visible.map(rowHtml).join('')
        : `<div class="session-picker-empty muted">${emptyText}${notes.length ? `：${notes.join('；')}。已选配置仍会保留` : ''}</div>`;
      if (tipEl) tipEl.textContent = tipText(visible.length);
    }
    if (totalEl) totalEl.textContent = pickerSummaryOf([...chosen]) || '未选择';
  };

  searchEl.addEventListener('input', () => {
    state.query = String(searchEl.value || '').trim().toLowerCase();
    render();
  });
  onlyEl.addEventListener('change', () => { state.onlySelected = onlyEl.checked; render(); });
  overlay.querySelectorAll('.session-picker-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab || 'all';
      for (const node of overlay.querySelectorAll('.session-picker-tab')) {
        const on = node === tab;
        node.classList.toggle('is-on', on);
        node.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      render();
    });
  });
  // 全选/清空只作用在当前筛选出来的行：先搜「私聊」再点全选，就是"所有私聊"。
  overlay.querySelector('.session-picker-all').addEventListener('click', () => {
    for (const item of visibleItems()) chosen.add(item.key);
    render();
  });
  overlay.querySelector('.session-picker-none').addEventListener('click', () => {
    for (const item of visibleItems()) chosen.delete(item.key);
    render();
  });
  listEl.addEventListener('change', (event) => {
    const box = event.target;
    if (!box?.classList?.contains('session-pick')) return;
    if (box.checked) chosen.add(box.value);
    else chosen.delete(box.value);
    if (totalEl) totalEl.textContent = pickerSummaryOf([...chosen]) || '未选择';
    if (tipEl) tipEl.textContent = tipText(visibleItems().length);
  });

  render();
  pickerLoadSessions(allowFriends).then(({ groups, friends, groupsFailed: gBad, friendsFailed: fBad }) => {
    groupsFailed = gBad;
    friendsFailed = fBad;
    items = pickerBuildItems({ groups, friends, selected: [...chosen] });
    loading = false;
    render();
  });
  return done;
}

/**
 * 在页面里渲染一个「已选摘要 + 选择」字段。boxId 对应容器；selected 是初始 key 列表。
 * allowFriends=false 时只列群（群游戏 / 群日报 / 早报这类按设计只发群的功能）。
 */
function renderSessionPicker(boxId, selected, { allowFriends = true, title = '选择会话', hint = '不勾 = 沿用聊天白名单' } = {}) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const keys = [...new Set((Array.isArray(selected) ? selected : []).map(pickerChatKey).filter(Boolean))];
  // 真源挂在容器自己的 dataset 上（而不是再套一层 hidden input）：保存时只读这里，
  // 页面其它地方重渲染容器时自然回到"未编辑"状态，旧值不会被当成新改动写回去。
  box.dataset.sessionValue = keys.join(',');
  box.dataset.sessionDirty = '0';
  box.classList?.add('session-picker');
  box.innerHTML = `
    <button type="button" class="session-picker-btn" aria-haspopup="dialog">
      <span class="session-picker-count${keys.length ? '' : ' is-empty'}">${esc(pickerSummaryOf(keys) || hint)}</span>
      <span class="session-picker-cta">选择</span>
    </button>
    <div class="session-picker-chips"></div>`;

  const countEl = box.querySelector?.('.session-picker-count');
  const chipsEl = box.querySelector?.('.session-picker-chips');
  // 名称表在加载后记住：用户随后在弹窗里改选，chips 仍用名称而不是退回号码。
  let pickerNames = new Map();
  const paintChips = (next) => {
    if (!chipsEl) return;
    const chips = next.slice(0, 3).map((key) => {
      const label = pickerNames.get(key) || pickerIdOf(key);
      return `<span class="session-picker-chip" title="${esc(key)}"><span class="session-picker-kind">${PICKER_KIND_LABEL[pickerKindOf(key)]}</span>${esc(label)}</span>`;
    });
    if (next.length > 3) chips.push(`<span class="session-picker-chip">等 ${next.length - 3} 个</span>`);
    chipsEl.innerHTML = chips.join('');
  };
  const apply = (next) => {
    const changed = box.dataset.sessionValue !== next.join(',');
    box.dataset.sessionValue = next.join(',');
    box.dataset.sessionDirty = '1';
    if (countEl) {
      countEl.textContent = pickerSummaryOf(next) || hint;
      countEl.classList?.toggle('is-empty', next.length === 0);
    }
    paintChips(next);
    // 让设置页的"有未保存改动"提示亮起来（弹窗挂在 body 上，change 不会自己冒泡到表单）；
    // 打开弹窗什么都没改就点确定时不动 dirty 提示。
    if (changed) {
      try { box.dispatchEvent(new Event('change', { bubbles: true })); } catch { /* 非浏览器环境 */ }
    }
  };
  // 先按号码画一遍（不等网络），名称回来后再补一次；补名称不动 dirty。
  paintChips(keys);

  box.querySelector?.('.session-picker-btn')?.addEventListener('click', async () => {
    const applied = await openSessionPicker({ title, allowFriends, selected: pickerParseKeys(box.dataset.sessionValue) });
    if (applied) apply(applied);
  });

  pickerLoadSessions(allowFriends).then(({ groups, friends }) => {
    if (document.getElementById(boxId) !== box) return;   // 设置页已经重渲染过这一块
    const names = new Map();
    for (const group of groups) names.set(`group:${group.id}`, String(group.name || ''));
    for (const friend of friends) names.set(`private:${friend.id}`, String(friend.name || ''));
    pickerNames = names;
    paintChips(pickerParseKeys(box.dataset.sessionValue));
  });
}

/**
 * 保存时读取字段值。
 * - 字段不在场（在别的设置页保存）→ null，调用方跳过，不覆盖存量配置；
 * - 在场但用户没打开过选择器 → null，同样跳过；
 * - 用户点过确定（含清空）→ 返回数组（可能是空数组，表示明确清空）。
 */
function pickedSessionValues(boxId) {
  const box = document.getElementById(boxId);
  if (!box) return null;
  if (box.dataset?.sessionDirty !== '1') return null;
  return pickerParseKeys(box.dataset.sessionValue);
}

export { openSessionPicker, renderSessionPicker, pickedSessionValues };
