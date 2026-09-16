import { test, expect, type Page } from '@playwright/test';

async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter WAVES ONE' }).click();
  await expect(page.getByRole('heading', { name: 'Good morning, Amey.' })).toBeVisible();
}
async function navigate(page: Page, screen: string) {
  const desktop = page.getByRole('navigation', { name: 'Primary', exact: true });
  if (await desktop.isVisible()) {
    await desktop.getByRole('button', { name: new RegExp(`^${screen}`) }).click();
  } else {
    const mobile = page.getByRole('navigation', { name: 'Primary mobile' });
    if (['Home', 'Work', 'Approvals', 'Activity'].includes(screen)) await mobile.getByRole('button', { name: new RegExp(`^${screen}`) }).click();
    else { await mobile.getByRole('button', { name: 'More' }).click(); await page.getByRole('dialog').getByRole('button', { name: new RegExp(`^${screen}`) }).click(); }
  }
}

test('entry, review, reject, persistence and approval history', async ({ page }) => {
  await enter(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  for (const label of ['WHAT','WHY','IMPACT','RISK','COST','EVIDENCE']) await expect(dialog.getByRole('heading', { name: label, exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Add a reason');
  await dialog.getByLabel('Decision note').fill('Needs another sandbox verification.');
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Good morning, Amey.' })).toBeVisible();
  await navigate(page, 'Approvals');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: /Production deployment ready/ }).click();
  await expect(page.getByRole('dialog')).toContainText('rejected');
  await expect(page.getByRole('dialog')).toContainText('Needs another sandbox verification.');
  await expect(page.getByRole('button', { name: 'Simulate approved execution' })).toHaveCount(0);
});

test('goal planning, delegation and linked tasks', async ({ page }) => {
  await enter(page);
  await page.getByRole('button', { name: 'New goal', exact: true }).first().click();
  await page.getByLabel('Describe the outcome').fill('Get the new Waves website ready for launch');
  await page.getByRole('button', { name: 'Create execution plan' }).click();
  await expect(page.getByRole('dialog')).toContainText('Suggested owners');
  await page.getByRole('button', { name: 'Delegate plan', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('active');
  await expect(page.getByRole('heading', { name: 'EXECUTION PLAN', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button').filter({ hasText: /running/ }).first().click();
  await expect(page.getByRole('dialog')).toContainText('WHY THIS WORK EXISTS');
  await page.getByRole('button', { name: 'Verify & complete simulation' }).click();
  await expect(page.getByRole('dialog')).toContainText('completed');
});

test('commands, all navigation screens and no page overflow', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await enter(page);
  await page.screenshot({ path: `test-results/overview-${testInfo.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Open WAVES AI command' }).click();
  await page.getByRole('button', { name: 'Show me everything blocked', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('task(s) need intervention');
  await page.getByRole('button', { name: 'Review work', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();
  for (const screen of ['Goals','People','Systems','Files','AI','Settings','Activity']) {
    await navigate(page, screen);
    await expect(page.locator('main h1')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow, `horizontal page overflow on ${screen}`).toBe(false);
  }
  expect(errors).toEqual([]);
});

test('approved simulation, agent pause, incident recovery and audit', async ({ page }) => {
  await enter(page);
  await page.getByRole('button', { name: 'Review', exact: true }).first().click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await navigate(page, 'Approvals');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: /Production deployment ready/ }).click();
  await page.getByRole('button', { name: 'Simulate approved execution' }).click();
  await expect(page.getByRole('dialog')).toContainText('Simulated execution verified');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await navigate(page, 'AI');
  await page.getByRole('button', { name: 'Pause agent' }).click();
  await expect(page.getByRole('button', { name: 'Run inspection' })).toBeDisabled();
  await page.getByRole('button', { name: 'Resume agent' }).click();
  await page.getByRole('button', { name: 'Run inspection' }).click();
  await expect(page.getByText('1 simulated inspections')).toBeVisible();
  await navigate(page, 'Systems');
  await page.locator('.list-panel').first().getByRole('button').first().click();
  await page.getByRole('button', { name: 'Simulate recovery & verify' }).click();
  await expect(page.getByRole('dialog')).toContainText('resolved');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await navigate(page, 'Activity');
  await page.getByRole('button', { name: 'Audit table' }).click();
  await expect(page.getByRole('columnheader', { name: 'Approval state' })).toBeVisible();
});
