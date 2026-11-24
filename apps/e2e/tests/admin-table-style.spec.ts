import { test, expect } from '@playwright/test';

test('用户列表：行高亮、小按钮与页码分页', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000/?mock#settings/system');
  const list = page.getByRole('list', { name: '用户与权限列表' });
  await expect(list).toBeVisible();
  const roleBadge = list.locator('[data-slot="badge"]').first();
  expect(await roleBadge.evaluate((el) => getComputedStyle(el).fontSize)).toBe('10px');
  expect(await roleBadge.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(18);
  const row = list.locator('.data-row').first();
  await row.hover();
  await expect.poll(() => row.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  expect(await row.getByRole('button', { name: '管理', exact: true }).evaluate((el) => el.getBoundingClientRect().height)).toBe(28);
  expect(await page.getByRole('button', { name: '添加用户', exact: true }).evaluate((el) => el.getBoundingClientRect().height)).toBe(32);
  const pagination = page.getByRole('navigation', { name: '用户列表分页' });
  expect(await pagination.getByRole('button', { name: '第 1 页', exact: true }).evaluate((el) => el.getBoundingClientRect().height)).toBe(28);
  await expect(pagination.getByRole('button', { name: '第 1 页', exact: true })).toHaveAttribute('aria-current', 'page');
  for (let i = 0; i < 8; i++) {
    await page.getByRole('button', { name: '添加用户', exact: true }).click();
    await page.locator('#new-user-name').fill(`demo-user-${i}`);
    await page.locator('#new-user-password').fill('demo-test-only');
    await page.getByRole('button', { name: '创建用户', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await pagination.getByRole('button', { name: '第 1 页', exact: true }).click();
  await expect(list.locator('li')).toHaveCount(10);
  await pagination.getByRole('button', { name: '第 2 页', exact: true }).click();
  await expect(list.locator('li')).toHaveCount(1);
  await expect(pagination.getByRole('button', { name: '第 2 页', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: 'test-results/admin-table-style.png', fullPage: true });
});
