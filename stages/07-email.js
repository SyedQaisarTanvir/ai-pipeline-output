import { Resend } from 'resend';
import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const resend = new Resend(config.email.resendApiKey);

export async function sendReport(story, qaResult) {
  const { key } = story;
  const { analysis, reportPath, screenshotsDir, screenshotFiles } = qaResult;
  const overall = analysis.overall;

  logger.info(`[${key}] Stage 7: Sending QA report email`);

  const reportContent = await readFile(reportPath, 'utf8');

  // Attach all screenshots
  const attachments = [];
  for (const filename of screenshotFiles) {
    const content = await readFile(path.join(screenshotsDir, filename));
    attachments.push({
      filename,
      content: content.toString('base64'),
    });
  }

  const subject = `QA Report — ${key} — ${overall}`;

  const htmlBody = `
<html>
<body style="font-family: monospace; white-space: pre-wrap; background: #f9f9f9; padding: 20px;">
<h2 style="font-family: sans-serif;">QA Report — ${key} — ${overall}</h2>
<hr/>
<pre>${reportContent}</pre>
</body>
</html>`;

  const { data, error } = await resend.emails.send({
    from: config.email.from,
    to: config.email.to,
    subject,
    html: htmlBody,
    attachments,
  });

  if (error) throw new Error(`Email failed: ${JSON.stringify(error)}`);

  logger.info(`[${key}] Stage 7: Email sent (id: ${data?.id})`);
  return data;
}
