import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Enter workspace' }).click();
  await expect(page.getByRole('button', { name: 'Start translating' })).toBeEnabled();
}

test('authenticated capture, speakers, playback, final flush, download, restart, and logout', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const state = {
      tracks: [] as MediaStreamTrack[],
      play: [] as { at: number; duration: number }[],
    };
    (window as unknown as { audioTest: typeof state }).audioTest = state;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      state.tracks.push(...stream.getTracks());
      return stream;
    };
    const originalStart = Object.getOwnPropertyDescriptor(AudioBufferSourceNode.prototype, 'start')
      ?.value as AudioBufferSourceNode['start'];
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration?: number) {
      state.play.push({ at: when, duration: this.buffer?.duration ?? 0 });
      originalStart.call(this, when, offset, duration);
    };
  });
  await login(page);
  await page.screenshot({ path: 'test-results/workspace-desktop.png', fullPage: true });
  await page.getByLabel('Translate to').selectOption('th');
  await page.getByRole('button', { name: 'Voice + text' }).click();
  await page.getByRole('button', { name: 'Start translating' }).click();
  await expect(page.getByText('Speaker 0', { exact: true })).toBeVisible();
  await expect(page.getByText('Speaker 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mute playback', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute playback' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop session' }).click();
  await expect(page.getByRole('button', { name: 'Start new session' })).toBeEnabled();
  await expect(
    page.locator('.translated-text').filter({ hasText: 'สวัสดี คุณสบายดีไหม' }),
  ).toBeVisible();
  await expect(page.getByText('Final', { exact: true })).toHaveCount(2);
  const audio = await page.evaluate(() => {
    const state = (
      window as unknown as {
        audioTest: { tracks: MediaStreamTrack[]; play: { at: number; duration: number }[] };
      }
    ).audioTest;
    return { states: state.tracks.map((track) => track.readyState), play: state.play };
  });
  expect(audio.states.every((state) => state === 'ended')).toBe(true);
  expect(audio.play.length).toBeGreaterThan(0);
  for (let i = 1; i < audio.play.length; i++) {
    const current = audio.play[i];
    const previous = audio.play[i - 1];
    if (!current || !previous) throw new Error('Missing playback timing');
    expect(current.at).toBeGreaterThanOrEqual(previous.at + previous.duration);
  }
  await page.getByRole('button', { name: 'Copy transcript', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    'สวัสดี คุณสบายดีไหม',
  );
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download transcript', exact: true }).click();
  const artifact = await download;
  expect(await readFile(await artifact.path(), 'utf8')).toContain('我很好，谢谢。');
  await page.screenshot({ path: 'test-results/conversation-desktop.png', fullPage: true });
  await page.getByLabel('Translate to').selectOption('yue');
  await expect(page.getByRole('button', { name: 'Voice + text' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Text only', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Start new session' }).click();
  await expect(page.getByText('Session 02', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start new session' })).toBeEnabled({
    timeout: 10000,
  });
  await expect(page.getByText('Four minutes complete.', { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/conversation-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Workspace password')).toBeVisible();
  expect((await page.request.get('/api/config')).status()).toBe(401);
  expect(errors).toEqual([]);
});

test('microphone denial leaves the app ready to retry', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('Denied', 'NotAllowedError'));
  });
  await login(page);
  await page.getByRole('button', { name: 'Start translating' }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone access was denied');
  await expect(page.getByRole('button', { name: 'Start translating' })).toBeEnabled();
});

test('unexpected network interruption preserves the transcript', async ({ page, context }) => {
  await login(page);
  await page.getByLabel('Translate to').selectOption('th');
  await page.getByRole('button', { name: 'Start translating' }).click();
  await expect(page.getByText('Hello, how are you?', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole('alert')).toContainText(/interrupted|connect/);
  await expect(page.getByText('Hello, how are you?', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Start new session' })).toBeEnabled();
});

test('phone reading view defaults to English text and stops when hidden', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByRole('button', { name: 'Text only', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Translate to')).toHaveValue('en');
  await page.getByRole('button', { name: 'Start translating' }).click();
  await expect(
    page.locator('.translated-text').filter({ hasText: 'I am well, thank you.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.locator('.translated-text').first()).toHaveCSS('font-size', '22px');
  await page.screenshot({ path: 'test-results/phone-live-reading.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('alert')).toContainText('page was hidden');
  await expect(page.getByRole('button', { name: 'Start new session' })).toBeEnabled();
  await expect(
    page.locator('.translated-text').filter({ hasText: 'Hello, how are you?' }),
  ).toBeVisible();
});

test('full four-minute capture expires and allows a fresh session', async ({ page }) => {
  test.skip(
    process.env.SIMULATED_CAPTURE_SECONDS !== '240',
    'Run explicitly for the real-duration acceptance check.',
  );
  test.setTimeout(270_000);
  await login(page);
  await page.getByRole('button', { name: 'Start translating' }).click();
  await expect(page.locator('.session-chip').filter({ hasText: 'Listening live' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start new session' })).toBeEnabled({
    timeout: 255_000,
  });
  await expect(page.getByText('Four minutes complete.', { exact: false })).toBeVisible();
  await expect(
    page.locator('.translated-text').filter({ hasText: 'Hello, how are you?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start new session' }).click();
  await expect(page.getByText('Session 02', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop session' }).click();
  await expect(page.getByRole('button', { name: 'Start new session' })).toBeEnabled();
});

test('login rejects incorrect passwords and page refresh retains only authentication', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('wrong');
  await page.getByRole('button', { name: 'Enter workspace' }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect password');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Enter workspace' }).click();
  await expect(page.getByRole('button', { name: 'Start translating' })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start translating' })).toBeEnabled();
  await expect(page.getByText('A conversation starts with a word.')).toBeVisible();
});
