import { test, expect } from '@playwright/test';

test('会话管理：中文语义、当前会话、确认撤销其他会话', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000/?mock#settings/account');
  await expect(page.getByText('登录会话 / 访问令牌', { exact: true })).toBeVisible();
  await expect(page.getByText('当前会话', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('共 2 条 · 第 1 / 1 页 · 每页 10 条')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '撤销其他会话', exact: true }).click();
  await expect(page.getByText('共 1 条 · 第 1 / 1 页 · 每页 10 条')).toBeVisible();
  await expect(page.getByText('当前会话', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销其他会话', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'test-results/account-sessions.png', fullPage: true });
});
