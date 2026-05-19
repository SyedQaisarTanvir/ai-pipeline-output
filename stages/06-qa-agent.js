import axios from 'axios';
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';

// Vercel preview deployments sometimes show an auth wall.
// We try the URL with the bypass header first, then plain.
async function resolveVercelUrl(url) {
  // Try plain first
  try {
    const { status } = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });
    if (status !== 401 && status !== 403) return { url, bypassNeeded: false };
  } catch {}

  // Try with Vercel's automation bypass query param (no token needed for public deployments)
  const bypassUrl = `${url}?_vercel_no_interstitial=1`;
  try {
    const { status } = await axios.get(bypassUrl, {
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });
    if (status < 400) return { url: bypassUrl, bypassNeeded: true };
  } catch {}

  return { url, bypassNeeded: false };
}

export async function runQA(story, liveUrl) {
  const { key, workspaceDir } = story;
  const screenshotsDir = path.join(workspaceDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });

  logger.info(`[${key}] Stage 6: Vercel smoke test — ${liveUrl}`);

  const { url: testUrl } = await resolveVercelUrl(liveUrl);

  let browser;
  let smokeResult = { loaded: false, hasContent: false, consoleErrors: [] };

  try {
    browser = await chromium.launch({ headless: false, slowMo: 300 });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(`JS: ${err.message}`));

    try {
      await page.goto(testUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1500);

      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
      const isVercelLogin = bodyText.toLowerCase().includes('sign in') && bodyText.toLowerCase().includes('vercel');

      await page.screenshot({
        path: path.join(screenshotsDir, 'vercel-01-live.png'),
        fullPage: true,
      });
      logger.info('  Screenshot: Vercel live deployment');

      smokeResult = {
        loaded: true,
        hasContent: !isVercelLogin && bodyText.length > 50,
        isAuthWall: isVercelLogin,
        bodyText,
        consoleErrors: errors,
      };

      if (isVercelLogin) {
        logger.warn(`[${key}] Vercel deployment is behind an auth wall — local QA screenshots are the primary evidence`);
      }

    } catch (err) {
      logger.warn(`[${key}] Smoke test page error: ${err.message}`);
      smokeResult.error = err.message;
    }

    await page.waitForTimeout(500);

  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  logger.info(`[${key}] Stage 6: Smoke test — loaded: ${smokeResult.loaded}, auth wall: ${smokeResult.isAuthWall || false}`);

  return {
    smokeResult,
    screenshotsDir,
    screenshotFiles: ['vercel-01-live.png'],
  };
}
