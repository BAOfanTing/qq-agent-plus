/* global window */
import { expect } from '@playwright/test';
import { E2E_TOKEN } from './constants.mjs';

/** 用 API 登录，cookie 落在当前 browser context 里，后续 page.goto 直接是已登录态。 */
export async function login(page) {
  const response = await page.request.post('/api/login', { data: { token: E2E_TOKEN } });
  expect(response.ok(), `login failed: HTTP ${response.status()}`).toBeTruthy();
}

/**
 * 收集 console error / pageerror。
 * 过滤两类预期噪声：登录失败用例里的 401 网络日志、favicon 404。
 */
export function collectPageErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/401 \(Unauthorized\)/.test(text)) return;
    if (/favicon\.ico/.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

export async function tabNames(page) {
  return page.locator('#tabs .tab[data-tab]').evaluateAll((nodes) => nodes.map((node) => node.dataset.tab));
}

/** 窄屏下导航可能收起成抽屉：优先点可见 tab，点不到就直接调 switchTab。 */
export async function switchTo(page, tab) {
  const button = page.locator(`#tabs .tab[data-tab="${tab}"]`);
  if (await button.isVisible().catch(() => false)) {
    await button.click();
  } else {
    await page.evaluate((name) => window.switchTab?.(name), tab);
  }
  await expect(page.locator(`#view-${tab}`)).toHaveClass(/active/);
}
