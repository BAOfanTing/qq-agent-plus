// 设置 → 技能包：只读 Markdown 流程 + 工具白名单。
// 这里没有"保存整份设置"：开关和按群覆盖都即时写 /api/skills/state，避免与设置页的大保存互相覆盖。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';

const skillsDefer = (fn) => (typeof queueMicrotask === 'function' ? queueMicrotask(fn) : Promise.resolve().then(fn));

let skillsState = {
  enabled: false,
  enabledIds: [],
  perChat: {},
  skills: [],
  errors: [],
  chats: []
};
const skillsOption = {};

function skillsSetStatus(text, error = false) {
  const node = $('#skills-status');
  if (!node) return;
  node.textContent = text;
  node.style.color = error ? 'var(--danger, #c0392b)' : '';
}

function skillsChatLabel(key) {
  const chat = skillsState.chats.find((item) => item.key === key);
  if (chat?.chatName) return `${chat.chatName}（${key}）`;
  if (String(key).startsWith('group:')) return `群 ${String(key).slice(6)}`;
  if (String(key).startsWith('private:')) return `私聊 ${String(key).slice(8)}`;
  return String(key);
}

function skillsGlobalList() {
  return skillsState.skills.map((skill) => `
    <label class="checkbox-row" style="align-items:flex-start;gap:10px">
      <input type="checkbox" data-skill-global="${esc(skill.id)}" ${skillsState.enabledIds.includes(skill.id) ? 'checked' : ''} />
      <span>
        <b>${esc(skill.name)}</b> <span class="muted">${esc(skill.id)} · v${esc(skill.version)}</span>
        <span class="hint" style="display:block">${esc(skill.description || '（没有说明）')}</span>
        <span class="hint" style="display:block">允许工具：${skill.allowedTools.length ? skill.allowedTools.map(esc).join('、') : '（仅 finish）'}</span>
      </span>
    </label>`).join('');
}

function skillsRenderList() {
  const box = $('#skills-list');
  if (!box) return;
  box.innerHTML = skillsState.skills.length
    ? skillsGlobalList()
    : '<div class="hint">没有找到技能。把技能目录放到 <code>skills/&lt;id&gt;/</code>（内置）或 <code>data/skills/&lt;id&gt;/</code>，再点「重新扫描」。</div>';
  const enabled = $('#cfg-skills-enabled');
  if (enabled) enabled.checked = skillsState.enabled === true;
  const errors = $('#skills-errors');
  if (errors) {
    errors.innerHTML = skillsState.errors.length
      ? `<div class="hint" style="color:var(--danger,#c0392b)">有 ${skillsState.errors.length} 个技能目录没有加载：${skillsState.errors.map((item) => `${esc(item.id || '(未命名)')}：${esc(item.error)}`).join('；')}</div>`
      : '';
  }
  skillsRenderChatPicker();
}

function skillsRenderChatPicker() {
  const select = $('#skills-chat-select');
  if (!select) return;
  if (!skillsState.chats.length) {
    select.innerHTML = '<option value="">（还没有可用会话）</option>';
    skillsRenderChatSkills('');
    return;
  }
  const current = select.value || skillsOption.chatKey || '';
  select.innerHTML = skillsState.chats.map((chat) => `<option value="${esc(chat.key)}">${esc(skillsChatLabel(chat.key))}</option>`).join('');
  const next = skillsState.chats.some((chat) => chat.key === current) ? current : skillsState.chats[0].key;
  select.value = next;
  skillsRenderChatSkills(next);
}

function skillsRenderChatSkills(chatKey) {
  const box = $('#skills-chat-list');
  if (!box) return;
  if (!chatKey) {
    box.innerHTML = '<div class="hint">还没有可配置的会话。</div>';
    return;
  }
  const override = Array.isArray(skillsState.perChat[chatKey]) ? skillsState.perChat[chatKey] : null;
  const checked = override || skillsState.enabledIds;
  box.innerHTML = `
    <div class="hint">${override ? '这个会话有单独覆盖；保存后只影响这个会话。' : '当前跟随全局列表；勾选并保存后为这个会话建立覆盖。'}</div>
    ${skillsState.skills.map((skill) => `<label class="checkbox-row"><input type="checkbox" data-chat-skill="${esc(skill.id)}" ${checked.includes(skill.id) ? 'checked' : ''} /> <span>${esc(skill.name)} <span class="muted">${esc(skill.id)}</span></span></label>`).join('')}
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn btn-small btn-primary" id="skills-chat-save" type="button">保存这个会话</button>
      <button class="btn btn-small" id="skills-chat-follow" type="button" ${override ? '' : 'disabled'}>恢复跟随全局</button>
    </div>`;
}

async function skillsSaveState(next = {}) {
  try {
    const result = await api('/api/skills/state', {
      method: 'POST',
      body: JSON.stringify({
        enabled: next.enabled ?? skillsState.enabled,
        enabledIds: next.enabledIds ?? skillsState.enabledIds,
        perChat: next.perChat ?? skillsState.perChat
      })
    });
    skillsState.enabled = result.enabled === true;
    skillsState.enabledIds = Array.isArray(result.enabledIds) ? result.enabledIds : [];
    skillsState.perChat = result.perChat && typeof result.perChat === 'object' ? result.perChat : {};
    skillsSetStatus('已保存；下一轮会话生效。');
    skillsRenderList();
  } catch (error) {
    skillsSetStatus(`保存失败：${error?.message || error}`, true);
  }
}

async function skillsLoad() {
  try {
    const [skills, chats] = await Promise.all([
      api('/api/skills'),
      api('/api/chats').catch(() => ({ chats: [] }))
    ]);
    skillsState = {
      enabled: skills.enabled === true,
      enabledIds: Array.isArray(skills.enabledIds) ? skills.enabledIds : [],
      perChat: skills.perChat && typeof skills.perChat === 'object' ? skills.perChat : {},
      skills: Array.isArray(skills.skills) ? skills.skills : [],
      errors: Array.isArray(skills.errors) ? skills.errors : [],
      chats: Array.isArray(chats.chats) ? chats.chats : []
    };
    skillsSetStatus(skillsState.enabled ? '技能包已启用；关闭时不会注册 skill_list / skill_use。' : '技能包未启用。');
    skillsRenderList();
  } catch (error) {
    skillsSetStatus(`读取失败：${error?.message || error}`, true);
  }
}

function skillsBind(root) {
  if (root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  root.addEventListener('change', (event) => {
    const globalToggle = event.target?.closest?.('#cfg-skills-enabled');
    if (globalToggle) {
      void skillsSaveState({ enabled: globalToggle.checked });
      return;
    }
    const globalSkill = event.target?.closest?.('[data-skill-global]');
    if (globalSkill) {
      const id = globalSkill.dataset.skillGlobal;
      const set = new Set(skillsState.enabledIds);
      if (globalSkill.checked) set.add(id); else set.delete(id);
      void skillsSaveState({ enabledIds: [...set] });
      return;
    }
    if (event.target?.closest?.('#skills-chat-select')) {
      skillsRenderChatSkills($('#skills-chat-select')?.value || '');
    }
  });
  root.addEventListener('click', async (event) => {
    if (event.target?.closest?.('#skills-reload')) {
      try {
        const result = await api('/api/skills/reload', { method: 'POST', body: '{}' });
        skillsState.skills = Array.isArray(result.skills) ? result.skills : [];
        skillsState.errors = Array.isArray(result.errors) ? result.errors : [];
        skillsSetStatus(`已重新扫描：${skillsState.skills.length} 个技能。`);
        skillsRenderList();
      } catch (error) {
        skillsSetStatus(`扫描失败：${error?.message || error}`, true);
      }
      return;
    }
    if (event.target?.closest?.('#skills-chat-save')) {
      const chatKey = $('#skills-chat-select')?.value || '';
      if (!chatKey) return;
      const ids = [...root.querySelectorAll('[data-chat-skill]:checked')].map((node) => node.dataset.chatSkill);
      const perChat = { ...skillsState.perChat, [chatKey]: ids };
      await skillsSaveState({ perChat });
      return;
    }
    if (event.target?.closest?.('#skills-chat-follow')) {
      const chatKey = $('#skills-chat-select')?.value || '';
      if (!chatKey) return;
      const perChat = { ...skillsState.perChat };
      delete perChat[chatKey];
      await skillsSaveState({ perChat });
    }
  });
}

function renderSkillsSection() {
  skillsDefer(() => {
    const root = document.getElementById('settings-skills');
    if (!root) return;
    skillsBind(root);
    void skillsLoad();
  });
  return `
    <div id="settings-skills">
      <h3>技能包（Skill Pack）</h3>
      <p class="hint">技能是只读的工作方法（Markdown + 工具白名单），不是插件：不执行代码、不读文件、不拿密钥。
        启用后模型会先看到技能名称，用 <code>skill_use</code> 选中；本轮只能调用技能允许的工具。</p>
      <div class="field-row">
        <div class="field"><label class="checkbox-row"><input type="checkbox" id="cfg-skills-enabled" /> <span>启用技能包</span></label></div>
        <div class="field"><button class="btn btn-small" id="skills-reload" type="button">重新扫描技能目录</button></div>
      </div>
      <div id="skills-status" class="hint"></div>
      <div id="skills-errors"></div>
      <div id="skills-list" style="margin-top:12px"></div>
      <div class="field" style="margin-top:16px">
        <label for="skills-chat-select">按会话覆盖</label>
        <select id="skills-chat-select"></select>
        <div id="skills-chat-list" style="margin-top:8px"></div>
      </div>
    </div>`;
}

export { renderSkillsSection };
