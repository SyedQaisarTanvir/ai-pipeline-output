import { createServer } from 'http';
import { readFile, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { groqCreate } from '../utils/groq-agent.js';
import { logger } from '../utils/logger.js';

// Minimal static file server for local QA
function startServer(appDir, port) {
  const MIME = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };

  const server = createServer(async (req, res) => {
    const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const filePath = path.join(appDir, urlPath);
    try {
      const content = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      logger.info(`  Local server started at http://localhost:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

async function analyzeLocalResults(requirements, observations, consoleErrors) {
  const res = await groqCreate({
    messages: [
      {
        role: 'system',
        content: 'You are a QA analyst. Analyze test observations against requirements. Return JSON only: { "criteria": [{ "name": string, "result": "PASS"|"FAIL", "notes": string }], "overall": "PASS"|"PARTIAL"|"FAIL", "summary": string }',
      },
      {
        role: 'user',
        content: `Requirements:\n${requirements.slice(0, 2000)}\n\nObservations:\n${JSON.stringify(observations)}\n\nConsole errors:\n${consoleErrors.join('\n') || 'None'}`,
      },
    ],
    temperature: 0,
    max_tokens: 1000,
  });

  try {
    const text = res.choices[0].message.content.trim();
    const json = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(json);
  } catch {
    return {
      criteria: [{ name: 'App loads locally', result: 'PASS', notes: 'Manual check required' }],
      overall: 'PARTIAL',
      summary: 'QA analysis could not be fully parsed.',
    };
  }
}

export async function runLocalQA(story, appDir) {
  const { key, requirements, workspaceDir } = story;
  const screenshotsDir = path.join(workspaceDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });

  const PORT = 3000 + Math.floor(Math.random() * 1000);
  const localUrl = `http://localhost:${PORT}`;

  logger.info(`[${key}] Stage 3b: Local browser QA at ${localUrl}`);

  let server;
  let browser;

  try {
    server = await startServer(appDir, PORT);

    // headless:false — visible browser for Loom recording
    browser = await chromium.launch({ headless: false, slowMo: 350 });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push(`JS: ${err.message}`));

    const observations = [];

    // ── Screenshot 1: Initial load ──────────────────────────────────────
    await page.goto(localUrl, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(screenshotsDir, 'local-01-initial.png'), fullPage: true });
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));
    observations.push({ step: 'Initial load', title, bodyText });
    logger.info('  [local] Screenshot 1: initial load');

    // ── Find input + add button ─────────────────────────────────────────
    const inputSel = 'input[type="text"], input:not([type]):not([type="button"]):not([type="submit"]):not([type="checkbox"]), textarea';
    const inputEl = await page.$(inputSel);
    const addBtnEl = await page.$('button:not([class*="delete"]):not([class*="remove"]):not([class*="clear"])');
    logger.info(`  [local] Input found: ${!!inputEl} | Add button found: ${!!addBtnEl}`);

    if (inputEl && addBtnEl) {
      // ── Screenshot 2: Type into input ─────────────────────────────────
      await inputEl.click();
      await inputEl.fill('Buy groceries');
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(screenshotsDir, 'local-02-typing.png'), fullPage: true });
      logger.info('  [local] Screenshot 2: typing');

      // ── Screenshot 3: After add (click button) ─────────────────────────
      await addBtnEl.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(screenshotsDir, 'local-03-after-add.png'), fullPage: true });
      const afterAddText = await page.evaluate(() => document.body.innerText.slice(0, 400));
      observations.push({ step: 'After adding todo', bodyText: afterAddText });
      logger.info('  [local] Screenshot 3: after add');

      // Add a second item via Enter key
      await inputEl.fill('Read a book');
      await inputEl.press('Enter');
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(screenshotsDir, 'local-04-enter-key.png'), fullPage: true });
      observations.push({ step: 'Added second item via Enter key' });
      logger.info('  [local] Screenshot 4: enter key add');
    }

    // ── Screenshot 5: Mark complete ────────────────────────────────────
    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) {
      await checkbox.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(screenshotsDir, 'local-05-complete.png'), fullPage: true });
      const afterComplete = await page.evaluate(() => document.body.innerText.slice(0, 400));
      observations.push({ step: 'Marked todo complete', bodyText: afterComplete });
      logger.info('  [local] Screenshot 5: marked complete');
    }

    // ── Screenshot 6: Delete ────────────────────────────────────────────
    const deleteBtnSel = 'button[class*="delete"], button[class*="remove"], [data-action="delete"], .delete-btn, .btn-delete, button[aria-label*="elete"]';
    const deleteBtn = await page.$(deleteBtnSel);
    if (deleteBtn) {
      await deleteBtn.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(screenshotsDir, 'local-06-delete.png'), fullPage: true });
      const afterDelete = await page.evaluate(() => document.body.innerText.slice(0, 400));
      observations.push({ step: 'Deleted todo', bodyText: afterDelete });
      logger.info('  [local] Screenshot 6: deleted');
    }

    // ── Screenshot 7: Mobile 375px ─────────────────────────────────────
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(screenshotsDir, 'local-07-mobile.png'), fullPage: true });
    observations.push({ step: 'Mobile viewport 375px' });
    logger.info('  [local] Screenshot 7: mobile');

    // ── Screenshot 8: Reload — localStorage persistence ─────────────────
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(screenshotsDir, 'local-08-reload.png'), fullPage: true });
    const afterReload = await page.evaluate(() => document.body.innerText.slice(0, 400));
    observations.push({ step: 'After page reload (localStorage persistence)', bodyText: afterReload });
    logger.info('  [local] Screenshot 8: reload/persistence');

    await page.waitForTimeout(800);

    // Analyse with Groq
    const analysis = await analyzeLocalResults(requirements, observations, consoleErrors);
    logger.info(`[${key}] Stage 3b: Local QA — Overall: ${analysis.overall}`);

    // Write bug report
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const table = analysis.criteria.map(c =>
      `| ${c.name} | ${c.result === 'PASS' ? '✅ PASS' : '❌ FAIL'} | ${c.notes} |`
    ).join('\n');

    const screenshotFiles = [
      'local-01-initial.png', 'local-02-typing.png', 'local-03-after-add.png',
      'local-04-enter-key.png', 'local-05-complete.png', 'local-06-delete.png',
      'local-07-mobile.png', 'local-08-reload.png',
    ].filter(f => existsSync(path.join(screenshotsDir, f)));

    const bugReport = `# Local QA Report — ${key}
**Tested at:** ${now} UTC
**Test type:** Local (pre-deploy)
**Overall status:** ${analysis.overall}

## Test Results
| Acceptance Criterion | Result | Notes |
|----------------------|--------|-------|
${table}

## Console Errors
${consoleErrors.length === 0 ? '- None' : consoleErrors.map(e => `- ${e}`).join('\n')}

## Screenshots
${screenshotFiles.map(f => `- ${f}`).join('\n')}

## Summary
${analysis.summary}
`;

    await writeFile(path.join(workspaceDir, 'bug-report.md'), bugReport, 'utf8');

    return { analysis, screenshotsDir, screenshotFiles, reportPath: path.join(workspaceDir, 'bug-report.md') };

  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
    logger.info(`[${key}] Stage 3b: Local server stopped`);
  }
}
