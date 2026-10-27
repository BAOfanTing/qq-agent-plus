/* global document */
import { test, expect } from '@playwright/test';
import { E2E_PLUGIN_ID, E2E_TOKEN } from './constants.mjs';
import { collectPageErrors, login, switchTo, tabNames } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

test('登录：错 Token 留在登录框，对 Token 进入总览，?token= 自动登录后清理 URL', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#console-login')).toBeVisible();

  await page.fill('#console-token', 'definitely-wrong-token');
  await page.click('#console-login-form button[type="submit"]');
  await expect(page.locator('#console-login-error')).toContainText(/Token|不正确/);

  await page.fill('#console-token', E2E_TOKEN);
  await page.click('#console-login-form button[type="submit"]');
  await expect(page.locator('#view-overview')).toHaveClass(/active/);
  await expect(page.locator('#console-login')).toBeHidden();
});

test('?token= 自动登录后把 Token 从地址栏移除', async ({ page }) => {
  await page.goto(`/?token=${encodeURIComponent(E2E_TOKEN)}`);
  await expect(page.locator('#view-overview')).toHaveClass(/active/);
  await expect.poll(() => new URL(page.url()).searchParams.get('token')).toBeNull();
});

test('15 个页签逐一切换，且没有 console error / pageerror', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.goto('/');
  await expect(page.locator('#view-overview')).toHaveClass(/active/);

  const tabs = await tabNames(page);
  expect(tabs).toHaveLength(15);

  for (const tab of tabs) {
    await switchTo(page, tab);
    await page.waitForTimeout(80);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('设置保存：改发送频率后落盘，再还原', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="chat"]');

  const input = page.locator('#cfg-maxpermin');
  await expect(input).toBeVisible();
  await input.fill('81');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');

  const read = async () => (await (await page.request.get('/api/config')).json()).send.maxPerMinute;
  await expect.poll(read).toBe(81);

  await input.fill('80');
  await page.click('#save-cfg-btn');
  await expect.poll(read).toBe(80);
});

test('图片生成：自定义请求参数保存后回显', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');

  const area = page.locator('#cfg-img-extra-body');
  await expect(area).toBeAttached();
  await area.fill('{"output_watermark": false}');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');

  const read = async () => (await (await page.request.get('/api/config')).json()).imageGen.extraBody;
  await expect.poll(read).toEqual({ output_watermark: false });

  await page.reload();
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');
  await expect(page.locator('#cfg-img-extra-body')).toHaveValue(/"output_watermark": false/);
});

test('技能页：渲染内置技能并可全局启停', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'skills');
  await expect(page.locator('#skills-page')).toBeVisible();
  await page.click('[data-skills-view="installed"]');
  await expect(page.locator('#skills-list')).toContainText('群聊总结');
  await page.click('[data-skill-open="chat-summary"]');
  await expect(page.locator('#skills-detail')).toBeVisible();
  await page.click('[data-skill-back]');
  await expect(page.locator('#skills-list')).toBeVisible();

  const toggle = page.locator('#skills-enabled');
  await expect(toggle).toHaveCSS('width', '44px');
  const readEnabled = async () => (await (await page.request.get('/api/skills')).json()).enabled;
  await expect.poll(readEnabled).toBe(true);
  await toggle.click();
  await expect.poll(readEnabled).toBe(false);
  await toggle.click();
  await expect.poll(readEnabled).toBe(true);

  await page.click('[data-skills-view="publish"]');
  await expect(page.locator('#skills-publish-view')).toBeVisible();
  await expect(page.locator('#skills-publish-view')).toContainText('提交一个技能');
});

test('技能市场：预览、安装、已安装列表与卸载', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'skills');
  await page.click('[data-skills-view="market"]');
  await expect(page.locator('#skills-market-view')).toContainText('出行规划');
  await expect(page.locator('.skills-market-pagination')).toBeVisible();
  await page.click('[data-market-page="next"]');
  await expect(page.locator('.skills-market-page.is-on')).toHaveText('2');
  await page.click('[data-market-page="prev"]');

  await page.click('[data-market-open="trip-planner"]');
  await expect(page.locator('.skills-market-preview')).toContainText('目标：');
  await page.click('[data-market-install="trip-planner"]');
  await page.click('[data-confirm-accept]');

  await page.click('[data-skills-view="installed"]');
  await expect(page.locator('#skills-list')).toContainText('出行规划');
  await page.click('[data-skill-open="trip-planner"]');
  await expect(page.locator('#skills-detail')).toContainText('出行规划');
  await page.click('[data-skill-uninstall="trip-planner"]');
  await page.click('[data-confirm-accept]');
  await expect(page.locator('#skills-list')).not.toContainText('出行规划');
});

test('人物记忆：控制台按关键词检索记忆', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'people-memory');
  await page.fill('#gm-search-query', '面馆');
  await page.click('#gm-search-btn');
  await expect(page.locator('#gm-search-results')).toContainText('面馆');
});

test('长期记忆页：四个页签、记忆详情与召回测试可用', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'living-memory');
  await expect(page.locator('#living-memory-page h2')).toHaveText('长期记忆');
  await expect(page.locator('#lm-enabled')).toBeChecked();
  await expect(page.locator('#lm-shadow-semantic')).toBeAttached();
  await expect(page.locator('#lm-turn-retention')).toHaveValue('7');
  await expect(page.locator('#lm-status-filter')).toBeAttached();

  await page.click('[data-lm-tab="memories"]');
  await expect(page.locator('#lm-memory-list')).toContainText('NAS 迁移计划');
  await page.locator('.lm-memory-row', { hasText: 'NAS 迁移计划' }).click();
  await expect(page.locator('.lm-detail-card h3')).toHaveText('NAS 迁移计划');
  await page.click('[data-lm-back]');
  await expect(page.locator('#lm-memory-list')).toContainText('NAS 迁移计划');

  await page.click('[data-lm-tab="recall"]');
  await expect(page.locator('#lm-test')).toHaveText('测试召回');
  await page.fill('#lm-query', 'NAS 迁移备份');
  await page.click('#lm-test');
  await expect(page.locator('#lm-recall-result')).toContainText('NAS 迁移计划');

  await page.click('[data-lm-tab="settings"]');
  await expect(page.locator('#lm-enabled')).toBeVisible();
});

test('设置 → 实验功能：长期记忆卡片显示状态并可进入管理页', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('button[data-section="experiments"]');
  await expect(page.locator('#experiment-living-memory')).toBeVisible();
  await expect(page.locator('#living-memory-badge')).toHaveText('已固化');
  await expect(page.locator('#living-memory-state')).toContainText('运行中');
  await page.click('#lm-open-console');
  await expect(page.locator('#living-memory-page h2')).toHaveText('长期记忆');
});

test('语音服务切换：豆包/MiMo 各自恢复上次保存的音色', async ({ page }) => {
  await login(page);
  const setTts = async (data) => {
    const response = await page.request.post('/api/config', { data: { tts: { enabled: true, ...data } } });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  await setTts({
    provider: 'doubao',
    baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    voice: 'ICL_E2E_DOUBAO'
  });
  await setTts({
    provider: 'mimo',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: 'Chloe'
  });

  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');
  const service = page.locator('#cfg-tts-service');
  await expect(service.locator('option[value="mimo"]')).toHaveCount(1);
  await expect(service).toHaveValue('mimo');
  await expect(page.locator('#cfg-tts-voice')).toHaveValue('Chloe');

  await service.selectOption('doubao');
  await expect(page.locator('#cfg-tts-voice')).toHaveValue('ICL_E2E_DOUBAO');
  await service.selectOption('mimo');
  await expect(page.locator('#cfg-tts-voice')).toHaveValue('Chloe');

  // 自定义/自建没有内置模型：不能把 MiMo 的模型名原样留在框里
  await service.selectOption('custom');
  await expect(page.locator('#cfg-tts-model')).toHaveValue('');
});

test('图片生成切换预设：没有内置模型的预设不能沿用上一家的模型名', async ({ page }) => {
  await login(page);
  const saved = await page.request.post('/api/config', {
    data: {
      imageGen: {
        enabled: true,
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'Qwen/Qwen-Image'
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();

  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');
  const service = page.locator('#cfg-img-service');
  await expect(service.locator('option[value="modelscope"]')).toHaveCount(1);
  await expect(page.locator('#cfg-img-model')).toHaveValue('Qwen/Qwen-Image');

  await service.selectOption('modelscope');
  await expect(page.locator('#cfg-img-model')).toHaveValue('', { timeout: 3000 });
  await service.selectOption('siliconflow');
  await expect(page.locator('#cfg-img-model')).toHaveValue('Tongyi-MAI/Z-Image-Turbo');
});

test('生活层设置页可渲染、可保存，窄屏无横向溢出', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="life-feed"]');

  await expect(page.locator('#settings-lifefeed')).toBeVisible();
  await expect(page.locator('#lifefeed-status')).toContainText('未开启');

  const interval = page.locator('#cfg-lifefeed-interval');
  await expect(interval).toHaveValue('360');
  await interval.fill('300');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');

  const read = async () => (await (await page.request.get('/api/config')).json()).lifeFeed.forageIntervalMinutes;
  await expect.poll(read).toBe(300);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

  await interval.fill('360');
  await page.click('#save-cfg-btn');
  await expect.poll(read).toBe(360);
});

test('好友设置保存：改入站待批上限后落盘，再还原', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'friends');

  const input = page.locator('#cfg-identity-incoming-max-pending');
  await expect(input).toBeVisible();
  await input.fill('51');
  await page.click('#friend-feature-save');

  const read = async () => {
    const cfg = await (await page.request.get('/api/config')).json();
    return cfg.identityPilot?.incomingFriendRequest?.maxPending;
  };
  await expect.poll(read).toBe(51);

  await page.locator('#cfg-identity-incoming-max-pending').fill('50');
  await page.click('#friend-feature-save');
  await expect.poll(read).toBe(50);
});

test('插件目录：索引超过一页时分页', async ({ page }) => {
  const plugins = Array.from({ length: 30 }, (_, index) => ({
    id: `demo-${String(index + 1).padStart(2, '0')}`,
    name: `测试插件 ${String(index + 1).padStart(2, '0')}`,
    description: '分页回归用条目',
    version: '1.0.0',
    author: 'tester',
    category: '测试',
    tags: ['test'],
    capabilities: ['tools'],
    compatible: true,
    downloads: index,
    updatedAt: '2026-10-01'
  }));
  await page.route('**/api/plugins/index', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ plugins, skipped: [], sources: [{ name: '测试索引', ok: true, count: plugins.length }] })
  }));
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await expect(page.locator('.plugin-pagination')).toBeVisible();
  await page.click('[data-plugin-page="next"]');
  await expect(page.locator('.plugin-page.is-on')).toHaveText('2');
});

test('插件审批：待批请求能在插件详情里点「批准一次」', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await expect(page.locator('#plugins-page')).toBeVisible();

  await page.click('[data-plugin-pane="installed"]');
  const row = page.locator(`[data-plugin-open="${E2E_PLUGIN_ID}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();

  const block = page.locator(`[data-pd-settings="${E2E_PLUGIN_ID}"]`);
  await expect(block).toBeVisible({ timeout: 15_000 });
  await expect(block).toContainText('待你批准');
  await block.locator('[data-pd-approve-pending]').first().click();

  const read = async () => (await (await page.request.get(`/api/plugins/settings?id=${E2E_PLUGIN_ID}`)).json());
  await expect.poll(async () => (await read()).pending.length).toBe(0);
  const settings = await read();
  expect(settings.grants?.approvals?.write?.usesLeft ?? 0).toBeGreaterThan(0);
});

test('窄屏 390×844：15 个页签都没有横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/');
  const tabs = await tabNames(page);
  expect(tabs).toHaveLength(15);

  for (const tab of tabs) {
    await switchTo(page, tab);
    await page.waitForTimeout(150);
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll('body *')]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && (rect.right > document.documentElement.clientWidth + 1 || rect.left < -1);
        })
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className || '').replace(/\s+/g, '.')}`)
    }));
    expect(metrics.scrollWidth, `tab=${tab} 越界元素：${metrics.offenders.join(' | ')}`)
      .toBeLessThanOrEqual(metrics.clientWidth + 1);
  }
});
