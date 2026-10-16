import { expect, test } from '@playwright/test';
const password=process.env.DEMO_PASSWORD;
test('anonymous workspace recovers a session outage and validates sign-in',async({page})=>{
  let unavailable=true;
  await page.route('**/api/auth/me',async(route)=>{if(unavailable)await route.fulfill({status:503,json:{error:{message:'The restaurant service is temporarily unavailable.'}}});else await route.continue();});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Your workspace is temporarily unavailable.'})).toBeVisible();
  unavailable=false;await page.getByRole('button',{name:'Retry connection'}).click();
  await expect(page.getByRole('heading',{name:'Welcome back.'})).toBeVisible();
  await page.getByRole('button',{name:'Sign in to workspace'}).click();
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
  await expect(page.getByText('Enter your password.')).toBeVisible();
  await expect(page.getByRole('link',{name:'Orders',exact:true})).toHaveCount(0);
});
test('owner workspace supports narrow-screen navigation, keyboard focus, and safe sign out',async({page})=>{
  test.skip(!password,'Set DEMO_PASSWORD to the locally generated seed password.');
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');await page.getByLabel('Email address').fill('owner@newkarachi.test');await page.getByLabel('Password',{exact:true}).fill(password!);await page.getByRole('button',{name:'Sign in to workspace'}).click();
  await expect(page.getByRole('heading',{name:/A good day starts here/})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Open navigation'}).click();await expect(page.getByRole('dialog',{name:'Workspace navigation'})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Open navigation'})).toBeFocused();
  await page.getByRole('button',{name:'Open navigation'}).click();await page.getByRole('dialog').getByRole('link',{name:'Inventory',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.getByRole('heading',{name:'Every ingredient, accounted for.'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.reload();await expect(page.getByRole('heading',{name:'Every ingredient, accounted for.'})).toBeVisible();await page.getByRole('button',{name:'Sign out'}).click();await expect(page.getByRole('heading',{name:'Welcome back.'})).toBeVisible();
  await page.getByLabel('Email address').fill('owner@newkarachi.test');await page.getByLabel('Password',{exact:true}).fill(password!);await page.getByRole('button',{name:'Sign in to workspace'}).click();await expect(page.getByRole('heading',{name:'Every ingredient, accounted for.'})).toBeVisible();
});

test('sign-in recovers an expired anonymous session and preserves a normalized email session', async ({ page, context }) => {
  if (!password) throw new Error('The local browser runner must supply demo credentials.');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByLabel('Email address', { exact: true }).fill('  OWNER@NEWKARACHI.TEST  ');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  // Lose the anonymous cookie after the UI obtained its token: the first request
  // must be rejected, then the client obtains a new session and signs in safely.
  await context.clearCookies();
  const statuses: number[] = [];
  page.on('response', response => { if (new URL(response.url()).pathname === '/api/auth/login') statuses.push(response.status()); });
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.getByRole('heading', { name: /A good day starts here/ })).toBeVisible();
  expect(statuses).toEqual([403, 200]);
  await page.reload();
  await expect(page.getByRole('heading', { name: /A good day starts here/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('workspace search, date presets and inventory focus work together', async ({ page }) => {
  if (!password) throw new Error('The local browser runner must supply demo credentials.');
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill('owner@newkarachi.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.getByRole('heading', { name: /A good day starts here/ })).toBeVisible();
  await page.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Last 7 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const from = await page.getByLabel('Dashboard from date').inputValue();
  const to = await page.getByLabel('Dashboard to date').inputValue();
  expect((Date.parse(to) - Date.parse(from)) / 86400000).toBe(6);
  await page.getByRole('link', { name: /ingredients to review for expiry/ }).click();
  await expect(page).toHaveURL(/\/inventory\?focus=expiring$/);
  await expect(page.getByRole('button', { name: /^Expiring soon/ })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: 'Where would you like to go?' });
  await expect(search).toBeVisible();
  await search.getByRole('combobox', { name: 'Search pages and tools' }).fill('kitchen');
  await page.keyboard.press('Enter');
  await expect(search).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Good food. A steady kitchen.' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Search workspace', exact: true }).click();
  await expect(search).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Search workspace', exact: true })).toBeFocused();
});
