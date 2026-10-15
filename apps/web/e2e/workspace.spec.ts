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
