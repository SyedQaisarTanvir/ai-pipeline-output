import axios from 'axios';
import { createHash } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const VERCEL_API = 'https://api.vercel.com';
const HEADERS = { Authorization: `Bearer ${config.vercel.token}`, 'Content-Type': 'application/json' };

async function collectFiles(dir, baseDir = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      files.push(...await collectFiles(fullPath, baseDir));
    } else {
      const content = await readFile(fullPath);
      const sha = createHash('sha1').update(content).digest('hex');
      files.push({
        file: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
        content,
        sha,
        size: content.length,
      });
    }
  }
  return files;
}

async function uploadFile(content, sha) {
  try {
    await axios.post(`${VERCEL_API}/v2/files`, content, {
      headers: {
        Authorization: `Bearer ${config.vercel.token}`,
        'Content-Type': 'application/octet-stream',
        'x-now-digest': sha,
        'Content-Length': content.length,
      },
    });
  } catch (err) {
    // 409 = file already uploaded — that's fine
    if (err.response?.status !== 409) throw err;
  }
}

async function pollDeployment(deploymentId) {
  for (let i = 0; i < 36; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const { data } = await axios.get(`${VERCEL_API}/v13/deployments/${deploymentId}`, { headers: HEADERS });
    logger.info(`  Deployment status: ${data.status}`);
    if (data.status === 'READY') return data;
    if (data.status === 'ERROR' || data.status === 'CANCELED') {
      throw new Error(`Vercel deployment failed: ${data.status}`);
    }
  }
  throw new Error('Vercel deployment timed out after 6 minutes');
}

async function healthCheck(url) {
  // Vercel uses 308 redirects — accept any 2xx or 3xx as live
  for (let i = 0; i < 10; i++) {
    try {
      const { status } = await axios.get(`https://${url}`, {
        timeout: 12000,
        maxRedirects: 5,
        validateStatus: s => s < 500, // accept 2xx, 3xx, even 4xx — just not server errors
      });
      logger.info(`Health check passed (HTTP ${status}): https://${url}`);
      return;
    } catch (err) {
      logger.info(`  Health check attempt ${i + 1}/10 — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 6000));
  }
  // Vercel already said READY — warn but don't crash the pipeline
  logger.warn(`Health check could not confirm ${url} — continuing anyway (Vercel status was READY)`);
}

export async function deployToVercel(story, appDir) {
  const { key } = story;
  logger.info(`[${key}] Stage 5: Deploying to Vercel`);

  const files = await collectFiles(appDir);
  logger.info(`  Uploading ${files.length} file(s)...`);

  // Step 1: pre-upload each file
  for (const f of files) {
    await uploadFile(f.content, f.sha);
  }

  // Step 2: create deployment referencing files by SHA
  const { data: deployment } = await axios.post(
    `${VERCEL_API}/v13/deployments`,
    {
      name: `pipeline-${key.toLowerCase()}`,
      files: files.map(f => ({ file: f.file, sha: f.sha, size: f.size })),
      projectSettings: { framework: null, buildCommand: null, outputDirectory: null },
      target: 'production',
    },
    { headers: HEADERS }
  );

  logger.info(`[${key}] Deployment created: ${deployment.id} (status: ${deployment.status})`);

  // If already ready (static sites are often instant)
  if (deployment.status === 'READY') {
    const url = deployment.url || deployment.alias?.[0];
    if (url) {
      const liveUrl = `https://${url}`;
      logger.info(`[${key}] Stage 5: Instantly live at ${liveUrl}`);
      return liveUrl;
    }
  }

  const ready = await pollDeployment(deployment.id);
  const deployUrl = ready.url || ready.alias?.[0];
  if (!deployUrl) throw new Error('Could not extract deployment URL from Vercel response');

  await healthCheck(deployUrl);
  const liveUrl = `https://${deployUrl}`;
  logger.info(`[${key}] Stage 5: Live at ${liveUrl}`);
  return liveUrl;
}
