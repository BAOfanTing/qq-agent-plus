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

test('13 个页签逐一切换，且没有 console error / pageerror', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.goto('/');
  await expect(page.locator('#view-overview')).toHaveClass(/active/);

  const tabs = await tabNames(page);
  expect(tabs).toHaveLength(13);

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

test('窄屏 390×844：13 个页签都没有横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/');
  const tabs = await tabNames(page);
  expect(tabs).toHaveLength(13);

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
