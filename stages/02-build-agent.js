import path from 'path';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { groqCreate } from '../utils/groq-agent.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const SYSTEM_PROMPT = `You are a senior front-end engineer. You write complete, production-quality HTML/CSS/JS applications.

STRICT OUTPUT RULES:
- Return ONLY the raw HTML file content — no explanation, no markdown, no code fences
- The file must start with <!DOCTYPE html> and end with </html>
- ALL CSS must be inside a <style> tag in <head>
- ALL JavaScript must be inside a <script> tag before </body>
- NEVER use external CDN links, frameworks, or imports of any kind
- The app must be 100% self-contained in a single file`;

function extractHtml(text) {
  // Strip markdown code fences if model wrapped the output
  const fenceMatch = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  // Otherwise expect raw HTML starting with <!DOCTYPE
  const doctypeIdx = text.indexOf('<!DOCTYPE');
  if (doctypeIdx !== -1) return text.slice(doctypeIdx).trim();
  return text.trim();
}

function validateHtml(html) {
  const errors = [];
  if (html.length < 2000) errors.push(`File too small (${html.length} chars) — likely incomplete`);
  if (!/<style[\s>]/i.test(html)) errors.push('No <style> tag found — CSS is missing');
  if (!/<script[\s>]/i.test(html)) errors.push('No <script> tag found — JavaScript is missing');
  if (!html.includes('localStorage')) errors.push('localStorage not used — persistence requirement missing');
  if (!html.includes('addEventListener')) errors.push('No event listeners found — functionality likely missing');
  return errors;
}

export async function buildApp(story) {
  const { key, requirements, workspaceDir } = story;
  const appDir = path.join(workspaceDir, 'app');
  await mkdir(appDir, { recursive: true });

  logger.info(`[${key}] Stage 2: Building app (${config.groq.buildModel})`);

  const userPrompt = `Build the following web application. Return ONLY the complete index.html file — no explanation, no markdown fences.

${requirements}`;

  let html = '';
  let lastErrors = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    logger.info(`[${key}]   Build attempt ${attempt}/3`);

    const messages = [{ role: 'user', content: userPrompt }];

    if (attempt > 1 && lastErrors.length > 0) {
      messages.push({
        role: 'assistant',
        content: html || '(previous attempt produced incomplete output)',
      });
      messages.push({
        role: 'user',
        content: `The previous output had these issues:\n${lastErrors.map(e => `- ${e}`).join('\n')}\n\nRewrite the COMPLETE index.html from scratch, fixing all issues. Return ONLY raw HTML starting with <!DOCTYPE html>.`,
      });
    }

    const response = await groqCreate({
      model: config.groq.buildModel,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      temperature: 0.1,
      max_tokens: 8000,
    });

    const raw = response.choices[0].message.content || '';
    html = extractHtml(raw);

    const errors = validateHtml(html);
    if (errors.length === 0) {
      logger.info(`[${key}]   Build validated — ${html.length} chars`);
      break;
    }

    lastErrors = errors;
    logger.warn(`[${key}]   Attempt ${attempt} validation failed: ${errors.join(' | ')}`);
    if (attempt === 3) {
      logger.warn(`[${key}]   Using best attempt despite validation warnings`);
    }
  }

  if (!html || html.length < 500) {
    throw new Error(`Build failed: output too short or empty for ${key}`);
  }

  const outPath = path.join(appDir, 'index.html');
  await writeFile(outPath, html, 'utf8');
  logger.info(`[${key}] Stage 2: Written app/index.html (${html.length} chars)`);

  return appDir;
}
