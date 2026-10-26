// 长期语义记忆页面：独立于会话 handoff 与人物印象，负责服务状态、召回验证、记忆维护与图谱解释。
import { api } from '../core/api.js';
import { askForConfirmation, setBoxError, setHtmlIfChanged } from '../core/dom-util.js';
import { $, esc } from '../core/dom.js';
import { iconSvg } from '../core/icons.js';
import { state } from '../core/state.js';

const TYPE_LABELS = {
  episode: '事件', fact: '事实', profile: '人物画像', preference: '偏好',
  commitment: '约定', project: '项目', rule: '规则'
};

const RECALL_MODE_LABELS = {
  hybrid: '混合检索',
  'hybrid-degraded': '关键词检索（语义分支暂时降级）',
  'lexical-pending-vectors': '关键词检索（等待首条向量记忆）',
  lexical: '关键词检索'
};

function scopeTitle(key, chats = []) {
  const found = chats.find((chat) => chat.key === key);
  if (found?.chatName) return `${found.chatName}（${key.slice(key.indexOf(':') + 1)}）`;
  if (key === 'owner-global') return '管理员全局知识';
  return key.startsWith('group:') ? `群聊 ${key.slice(6)}` : `私聊 ${key.slice(8)}`;
}

function selectedScope() {
  return state.livingMemory.selectedScope || '';
}

function shortDate(value) {
  const time = Number(value) || 0;
  if (!time) return '-';
  try { return new Date(time).toLocaleString('zh-CN', { hour12: false }); } catch { return '-'; }
}

function statePill(ok, text) {
  return `<span class="lm-state ${ok ? 'ok' : 'bad'}"><i></i>${esc(text)}</span>`;
}

function recallModeLabel(mode) {
  return RECALL_MODE_LABELS[String(mode || '')] || String(mode || 'unknown');
}

function cardHtml(memory, { selected = false } = {}) {
  const tags = (memory.tags || []).slice(0, 5).map((tag) => `<span>${esc(tag)}</span>`).join('');
  const vector = memory.vectorStatus === 'ready' ? '已向量化'
    : memory.vectorStatus === 'none' ? '仅关键词'
      : memory.vectorStatus === 'error' ? '向量失败' : '待处理';
  const archived = memory.status === 'archived';
  return `<article class="lm-card ${selected ? 'selected' : ''} ${archived ? 'is-archived' : ''}" data-lm-memory="${esc(memory.id)}">
    <button type="button" class="lm-card-main" data-lm-open="${esc(memory.id)}">
      <div class="lm-card-top"><span class="lm-type">${esc(TYPE_LABELS[memory.type] || memory.type || '记忆')}</span><span>${archived ? '已归档' : `重要度 ${Number(memory.importance || 0).toFixed(1)}`}</span></div>
      <strong>${esc(memory.summary || memory.content || '未命名记忆')}</strong>
      <p>${esc(memory.content || '')}</p>
      <div class="lm-card-meta"><span>${esc(vector)}</span><span>${esc(shortDate(memory.updatedAt))}</span></div>
      ${tags ? `<div class="lm-tags">${tags}</div>` : ''}
    </button>
    <div class="lm-card-actions">
      ${archived
        ? `<button type="button" class="btn btn-small" data-lm-restore="${esc(memory.id)}">恢复</button>`
        : `<button type="button" class="btn btn-small" data-lm-archive="${esc(memory.id)}">归档</button>`}
      <button type="button" class="btn btn-small btn-danger" data-lm-delete="${esc(memory.id)}">删除</button>
    </div>
  </article>`;
}

function graphHtml(graph = {}) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.slice(0, 60) : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.slice(0, 120) : [];
  if (!nodes.length) return '<div class="empty-hint">当前范围还没有可视化的实体关系。</div>';
  const width = 760;
  const height = 340;
  const center = { x: width / 2, y: height / 2 };
  const positions = new Map(nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / nodes.length - Math.PI / 2;
    const radius = node.type === 'memory' ? 90 : 135;
    return [node.id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }];
  }));
  const lines = edges.map((edge) => {
    const source = positions.get(edge.source); const target = positions.get(edge.target);
    return source && target ? `<line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" />` : '';
  }).join('');
  const marks = nodes.map((node) => {
    const point = positions.get(node.id);
    const label = String(node.label || '').slice(0, 16);
    return `<g class="${node.type === 'memory' ? 'memory-node' : 'entity-node'}"><circle cx="${point.x}" cy="${point.y}" r="${node.type === 'memory' ? 10 : 7}"/><text x="${point.x}" y="${point.y + 22}">${esc(label)}</text></g>`;
  }).join('');
  return `<div class="lm-graph-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="长期记忆关系图谱"><g class="lm-graph-edges">${lines}</g>${marks}</svg></div>`;
}

function detailHtml(memory) {
  if (!memory) return '<div class="empty-hint">选择一条记忆，查看来源、标签与关系。</div>';
  const relations = (memory.relations || []).map((relation) => `<li>${esc(relation.source)} <b>${esc(relation.predicate || '关联')}</b> ${esc(relation.target)}</li>`).join('');
  const entities = (memory.entities || []).map((entity) => `<span>${esc(entity)}</span>`).join('');
  const tags = (memory.tags || []).map((tag) => `<span>${esc(tag)}</span>`).join('');
  const source = memory.source || {};
  return `<div class="lm-detail-head"><div><span class="lm-type">${esc(TYPE_LABELS[memory.type] || memory.type)}</span><h3>${esc(memory.summary)}</h3></div>${statePill(memory.status === 'active', memory.status === 'active' ? '活跃' : '已归档')}</div>
    <section class="lm-detail-section"><h4>记忆正文</h4><p>${esc(memory.content)}</p></section>
    <div class="lm-facts"><div><small>重要度</small><strong>${Number(memory.importance || 0).toFixed(1)}</strong></div><div><small>置信度</small><strong>${Math.round((Number(memory.confidence) || 0) * 100)}%</strong></div><div><small>向量状态</small><strong>${esc(memory.vectorStatus || '-')}</strong></div><div><small>最后更新</small><strong>${esc(shortDate(memory.updatedAt))}</strong></div></div>
    <section class="lm-detail-section"><h4>标签</h4><div class="lm-tags">${tags || '<span>无</span>'}</div></section>
    <section class="lm-detail-section"><h4>实体</h4><div class="lm-tags">${entities || '<span>无</span>'}</div></section>
    <section class="lm-detail-section"><h4>关系</h4>${relations ? `<ul class="lm-relations">${relations}</ul>` : '<p class="muted">暂无关系</p>'}</section>
    <section class="lm-detail-section"><h4>来源</h4><p class="muted">会话：${esc((source.sessionIds || []).join('、') || '手动创建')} · 聚合 ${Number(source.turnCount) || 0} 个回合</p></section>`;
}

function renderPage({ chats, status, list, graph }) {
  const box = $('#living-memory-page');
  if (!box) return;
  const cfg = status?.config || state.config?.livingMemory || {};
  const runtime = status?.status || {};
  const serviceOk = runtime?.status?.ok === true || runtime?.ok === true;
  const stats = runtime?.status?.stats || runtime?.stats || {};
  const embeddingConfigured = runtime?.status?.embedding?.configured || runtime?.embedding?.configured;
  const vectorReady = Number(stats.vectorReady || 0) > 0;
  const scope = selectedScope();
  const scopes = (chats || []).filter((chat) => /^(group|private):\d+$/.test(chat.key));
  if (cfg.allowGlobal === true) scopes.unshift({ key: 'owner-global', chatName: '管理员全局知识' });
  const scopeOptions = scopes.map((chat) => `<option value="${esc(chat.key)}" ${chat.key === scope ? 'selected' : ''}>${esc(scopeTitle(chat.key, chats))}</option>`).join('');
  const entries = list?.entries || [];
  const error = state.livingMemory.pageError;
  const serviceNote = serviceOk
    ? `${statePill(true, embeddingConfigured ? (vectorReady ? '本地存储 · 混合检索可用' : '本地存储 · 等待首条向量记忆') : '本地存储 · 当前仅关键词检索')}`
    : statePill(false, runtime?.status?.error || runtime?.error || '长期记忆初始化失败');
  const html = `<div class="lm-page-head"><div><span class="eyebrow">实验功能 · 本地优先</span><h2>长期记忆</h2><p>用语义检索保存事件、项目、约定和群内知识；默认按会话隔离，不把其他群的内容带进当前回复。</p></div><div class="lm-service-state">${serviceNote}</div></div>
    ${error ? `<div class="lm-error">${esc(error)}</div>` : ''}
    <section class="lm-overview-grid">
      <article><span>活跃记忆</span><strong>${Number(stats.active || 0)}</strong><small>全部 ${Number(stats.total || 0)} 条</small></article>
      <article><span>已向量化</span><strong>${Number(stats.vectorReady || 0)}</strong><small>可做语义检索</small></article>
      <article><span>来源回合</span><strong>${Number(stats.turns || 0)}</strong><small>本地 SQLite 留痕</small></article>
      <article><span>运行模式</span><strong>${cfg.enabled === true ? (cfg.mode === 'active' ? '注入' : '影子') : '关闭'}</strong><small>${cfg.enabled === true ? '可随时回退' : '不写入、不召回'}</small></article>
    </section>
    <section class="lm-panel lm-config"><div class="lm-panel-head"><div><h3>运行策略</h3><p>影子模式会写入并记录召回结果，但不会影响 QQ 回复；确认质量后再切换到“注入”。</p></div><button type="button" class="btn btn-small" id="lm-refresh">${iconSvg('refresh', { size: 14 })}刷新</button></div>
      <div class="lm-form-grid">
        <label class="checkbox-row"><input id="lm-enabled" type="checkbox" ${cfg.enabled === true ? 'checked' : ''} /><span>启用长期记忆</span></label>
        <label class="checkbox-row"><input id="lm-private" type="checkbox" ${cfg.allowPrivate === true ? 'checked' : ''} /><span>允许私聊自动记忆</span></label>
        <label class="checkbox-row"><input id="lm-global" type="checkbox" ${cfg.allowGlobal === true ? 'checked' : ''} /><span>允许管理员全局知识</span></label>
        <label class="checkbox-row"><input id="lm-shadow-semantic" type="checkbox" ${cfg.shadowSemantic === true ? 'checked' : ''} /><span>影子模式也跑语义召回（会调用 Embedding）</span></label>
        <label>运行模式<select id="lm-mode"><option value="shadow" ${cfg.mode !== 'active' ? 'selected' : ''}>影子：不注入回复</option><option value="active" ${cfg.mode === 'active' ? 'selected' : ''}>注入：回复前召回</option></select></label>
        <label>每次注入上限（字符）<input id="lm-max-chars" type="number" min="300" max="8000" value="${Number(cfg.maxInjectChars) || 2400}" /></label>
        <label>每轮最多召回<input id="lm-max-items" type="number" min="1" max="16" value="${Number(cfg.maxRecallItems) || 6}" /></label>
        <label>召回等待上限（毫秒）<input id="lm-recall-timeout" type="number" min="300" max="5000" step="100" value="${Number(cfg.recallTimeoutMs) || 1800}" /></label>
        <label>自动总结阈值（回合）<input id="lm-capture-min" type="number" min="2" max="60" value="${Number(cfg.captureMinMessages) || 6}" /></label>
        <label>来源回合保留（天）<input id="lm-turn-retention" type="number" min="1" max="365" value="${Number(cfg.turnRetentionDays) || 7}" /></label>
        <label>启用的群号（留空＝所有群）<input id="lm-groups" value="${esc((cfg.groups || []).join(','))}" placeholder="123456, 234567" /></label>
      </div><div class="lm-action-row"><button type="button" class="btn btn-primary" id="lm-save-config">保存长期记忆设置</button><span class="muted">向量模型地址与密钥由进程环境管理，不在网页中显示。</span></div>
    </section>
    <section class="lm-panel"><div class="lm-panel-head"><div><h3>召回测试</h3><p>先在影子模式验证匹配质量、作用域和注入内容。</p></div></div>
      <div class="lm-test-bar"><select id="lm-scope">${scopeOptions || '<option value="">暂无会话</option>'}</select><input id="lm-query" value="${esc(state.livingMemory.query || '')}" placeholder="输入问题或关键词，例如：之前讨论过 NAS 向量记忆吗？" /><button type="button" class="btn btn-primary" id="lm-test">测试召回</button></div>
      <div id="lm-recall-result">${renderRecall(state.livingMemory.recallResult)}</div>
    </section>
    <section class="lm-two-col"><div class="lm-panel"><div class="lm-panel-head"><div><h3>记忆管理</h3><p>${scope ? esc(scopeTitle(scope, chats)) : '先选择一个会话'}</p></div><div class="lm-list-tools"><select id="lm-status-filter"><option value="" ${!state.livingMemory.statusFilter ? 'selected' : ''}>全部状态</option><option value="active" ${state.livingMemory.statusFilter === 'active' ? 'selected' : ''}>仅活跃</option><option value="archived" ${state.livingMemory.statusFilter === 'archived' ? 'selected' : ''}>仅已归档</option></select><span class="muted">${Number(list?.total || 0)} 条</span></div></div>
      <details class="lm-create"><summary>手动新建记忆</summary><div class="lm-form-grid"><label>类型<select id="lm-new-type">${Object.entries(TYPE_LABELS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label><label>重要度<input id="lm-new-importance" type="number" min="0" max="10" step="0.1" value="5" /></label></div><label>摘要<input id="lm-new-summary" maxlength="260" placeholder="一句话概括这条长期记忆" /></label><label>正文<textarea id="lm-new-content" rows="4" maxlength="1600" placeholder="保存有长期价值、可验证的信息；不要输入密码、Token 或敏感资料。"></textarea></label><label>标签（逗号分隔）<input id="lm-new-tags" placeholder="项目, NAS, 约定" /></label><button type="button" class="btn btn-small btn-primary" id="lm-create">创建记忆</button></details>
      <div class="lm-list">${entries.length ? entries.map((memory) => cardHtml(memory, { selected: memory.id === state.livingMemory.selectedMemoryId })).join('') : '<div class="empty-hint">这个会话还没有长期记忆。启用影子模式后，让机器人完成若干轮有价值的对话即可自动提炼。</div>'}</div>
    </div><aside class="lm-panel lm-detail"><div class="lm-panel-head"><div><h3>记忆详情</h3><p>可追溯、可归档、可删除</p></div></div>${detailHtml(state.livingMemory.detail)}</aside></section>
    <section class="lm-panel"><div class="lm-panel-head"><div><h3>知识图谱</h3><p>实体与关系只来自当前会话范围内的记忆卡片。</p></div><button type="button" class="btn btn-small" id="lm-graph-refresh">刷新图谱</button></div>${graphHtml(graph)}</section>`;
  setHtmlIfChanged(box, html, { force: true });
  bindPage();
}

function renderRecall(result) {
  if (!result) return '<div class="empty-hint">输入问题后运行测试；结果会显示最终注入文本和排序理由。</div>';
  if (result.error) return `<div class="lm-error">${esc(result.error)}</div>`;
  const rows = (result.entries || []).map((entry) => `<article class="lm-recall-row"><div><strong>${esc(entry.summary)}</strong><p>${esc(entry.content)}</p></div><div><span>综合 ${Number(entry.retrieval?.score || 0).toFixed(3)}</span><small>语义 ${Number(entry.retrieval?.semantic || 0).toFixed(3)} · 关键词 ${Number(entry.retrieval?.lexical || 0)}</small></div></article>`).join('');
  return `<div class="lm-recall-note"><strong>${esc(recallModeLabel(result.mode))}</strong>${result.vectorError ? ` · 向量降级：${esc(result.vectorError)}` : ''}</div>${rows || '<div class="empty-hint">没有匹配记忆。</div>'}<details class="lm-injected"><summary>本轮会注入的上下文</summary><pre>${esc(result.injectedText || '影子模式或没有内容')}</pre></details>`;
}

let livingMemoryDelegationBound = false;

function parseGroups(value) {
  return [...new Set(String(value || '').split(/[,，\s]+/).map((item) => item.trim()).filter((item) => /^\d{1,15}$/.test(item)))];
}

function bindPage() {
  $('#lm-refresh')?.addEventListener('click', () => loadLivingMemoryPage({ force: true }));
  $('#lm-scope')?.addEventListener('change', (event) => {
    state.livingMemory.selectedScope = event.target.value;
    state.livingMemory.selectedMemoryId = '';
    state.livingMemory.detail = null;
    state.livingMemory.list = null;
    state.livingMemory.graph = null;
    void loadLivingMemoryPage({ force: true });
  });
  $('#lm-save-config')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const patch = {
        enabled: $('#lm-enabled')?.checked === true,
        graduated: state.config?.livingMemory?.graduated === true,
        mode: $('#lm-mode')?.value === 'active' ? 'active' : 'shadow',
        allowPrivate: $('#lm-private')?.checked === true,
        allowGlobal: $('#lm-global')?.checked === true,
        shadowSemantic: $('#lm-shadow-semantic')?.checked === true,
        turnRetentionDays: Number($('#lm-turn-retention')?.value),
        maxInjectChars: Number($('#lm-max-chars')?.value),
        maxRecallItems: Number($('#lm-max-items')?.value),
        recallTimeoutMs: Number($('#lm-recall-timeout')?.value),
        captureMinMessages: Number($('#lm-capture-min')?.value),
        groups: parseGroups($('#lm-groups')?.value)
      };
      const result = await api('/api/config', { method: 'POST', body: JSON.stringify({ livingMemory: patch }) });
      state.config = result.config || state.config;
      state.livingMemory.pageError = '';
      await loadLivingMemoryPage({ force: true });
    } catch (error) { state.livingMemory.pageError = `保存失败：${error.message}`; await loadLivingMemoryPage({ force: true }); }
    finally { button.disabled = false; }
  });
  $('#lm-test')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const chatKey = selectedScope();
    const query = String($('#lm-query')?.value || '').trim();
    if (!chatKey || !query) { state.livingMemory.pageError = '请选择会话并输入测试问题'; await loadLivingMemoryPage({ force: true }); return; }
    button.disabled = true;
    state.livingMemory.query = query;
    try {
      state.livingMemory.recallResult = await api('/api/living-memory/recall-test', { method: 'POST', body: JSON.stringify({ chatKey, query }) });
      state.livingMemory.pageError = '';
    } catch (error) { state.livingMemory.recallResult = { error: error.message }; }
    finally { button.disabled = false; await loadLivingMemoryPage({ force: true }); }
  });
  $('#lm-create')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; const scopeKey = selectedScope();
    const summary = String($('#lm-new-summary')?.value || '').trim();
    const content = String($('#lm-new-content')?.value || '').trim();
    if (!scopeKey || !summary || !content) { state.livingMemory.pageError = '请选择会话，并填写摘要与正文'; await loadLivingMemoryPage({ force: true }); return; }
    button.disabled = true;
    try {
      await api('/api/living-memory/memories', { method: 'POST', body: JSON.stringify({
        scopeKey, summary, content, type: $('#lm-new-type')?.value || 'episode',
        importance: Number($('#lm-new-importance')?.value) || 5,
        confidence: 1, tags: String($('#lm-new-tags')?.value || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean)
      }) });
      state.livingMemory.pageError = '';
      state.livingMemory.list = null;
    } catch (error) { state.livingMemory.pageError = `创建失败：${error.message}`; }
    finally { button.disabled = false; await loadLivingMemoryPage({ force: true }); }
  });
  $('#lm-graph-refresh')?.addEventListener('click', () => { state.livingMemory.graph = null; void loadLivingMemoryPage({ force: true }); });
  $('#lm-status-filter')?.addEventListener('change', (event) => {
    state.livingMemory.statusFilter = event.target.value;
    state.livingMemory.list = null;
    void loadLivingMemoryPage({ force: true });
  });
  // 容器是稳定节点，每次渲染都重挂 click 会让一次删除发 N 次请求；只绑一次。
  if (livingMemoryDelegationBound) return;
  livingMemoryDelegationBound = true;
  $('#living-memory-page')?.addEventListener('click', async (event) => {
    const open = event.target.closest('[data-lm-open]');
    const archive = event.target.closest('[data-lm-archive]');
    const restore = event.target.closest('[data-lm-restore]');
    const remove = event.target.closest('[data-lm-delete]');
    try {
      if (open) {
        const id = open.dataset.lmOpen;
        const result = await api(`/api/living-memory/memories/${encodeURIComponent(id)}`);
        state.livingMemory.selectedMemoryId = id;
        state.livingMemory.detail = result.memory || null;
        await loadLivingMemoryPage({ force: true });
      }
      if (archive && await askForConfirmation('归档这条长期记忆？归档后它不会再参与自动召回。')) {
        await api(`/api/living-memory/memories/${encodeURIComponent(archive.dataset.lmArchive)}/archive`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
        state.livingMemory.list = null; state.livingMemory.detail = null; state.livingMemory.selectedMemoryId = '';
        await loadLivingMemoryPage({ force: true });
      }
      if (restore && await askForConfirmation('恢复这条长期记忆？恢复后会重新参与自动召回。')) {
        await api(`/api/living-memory/memories/${encodeURIComponent(restore.dataset.lmRestore)}/restore`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
        state.livingMemory.list = null; state.livingMemory.detail = null; state.livingMemory.selectedMemoryId = '';
        await loadLivingMemoryPage({ force: true });
      }
      if (remove && await askForConfirmation('彻底删除这条长期记忆及其向量索引？此操作不可恢复。')) {
        await api(`/api/living-memory/memories/${encodeURIComponent(remove.dataset.lmDelete)}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
        state.livingMemory.list = null; state.livingMemory.detail = null; state.livingMemory.selectedMemoryId = '';
        await loadLivingMemoryPage({ force: true });
      }
    } catch (error) { state.livingMemory.pageError = `操作失败：${error.message}`; await loadLivingMemoryPage({ force: true }); }
  });
}

async function loadLivingMemoryPage() {
  const box = $('#living-memory-page');
  if (!box) return;
  try {
    const [status, chatData] = await Promise.all([
      api('/api/living-memory/status'),
      api('/api/chats')
    ]);
    const chats = chatData?.chats || [];
    const cfg = status?.config || state.config?.livingMemory || {};
    if (!selectedScope()) {
      const first = chats.find((chat) => chat.key.startsWith('group:')) || chats[0];
      state.livingMemory.selectedScope = first?.key || (cfg.allowGlobal ? 'owner-global' : '');
    }
    const scope = selectedScope();
    const [list, graph] = scope ? await Promise.all([
      api(`/api/living-memory/memories?scopeKey=${encodeURIComponent(scope)}&limit=100&status=${encodeURIComponent(state.livingMemory.statusFilter || '')}`),
      api(`/api/living-memory/graph?scopeKey=${encodeURIComponent(scope)}&limit=160`)
    ]) : [{ entries: [], total: 0 }, { nodes: [], edges: [] }];
    state.livingMemory.status = status;
    state.livingMemory.list = list;
    state.livingMemory.graph = graph;
    renderPage({ chats, status, list, graph });
  } catch (error) {
    state.livingMemory.pageError = `读取长期记忆失败：${error.message}`;
    setBoxError(box, `<div class="empty-hint">${esc(state.livingMemory.pageError)}</div>`);
  }
}

export { loadLivingMemoryPage };
