import axios from 'axios';
import { readFile } from 'fs/promises';
import path from 'path';
import { config, jiraAuthHeader } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const BASE = config.jira.baseUrl;
const HEADERS = jiraAuthHeader();

async function getTransitions(issueKey) {
  const res = await axios.get(`${BASE}/rest/api/3/issue/${issueKey}/transitions`, {
    headers: HEADERS,
  });
  return res.data.transitions;
}

async function transition(issueKey, targetNames) {
  const transitions = await getTransitions(issueKey);
  const match = transitions.find(t =>
    targetNames.some(name => t.name.toLowerCase().includes(name.toLowerCase()))
  );
  if (!match) {
    logger.warn(`[${issueKey}] No matching transition for [${targetNames.join(', ')}]. Available: ${transitions.map(t => t.name).join(', ')}`);
    // Fall back to first available terminal state
    const fallback = transitions.find(t =>
      t.name.toLowerCase().includes('done') ||
      t.name.toLowerCase().includes('closed') ||
      t.name.toLowerCase().includes('resolved')
    );
    if (!fallback) return;
    await axios.post(`${BASE}/rest/api/3/issue/${issueKey}/transitions`,
      { transition: { id: fallback.id } }, { headers: HEADERS });
    logger.info(`[${issueKey}] Transitioned to ${fallback.name} (fallback)`);
    return;
  }
  await axios.post(`${BASE}/rest/api/3/issue/${issueKey}/transitions`,
    { transition: { id: match.id } }, { headers: HEADERS });
  logger.info(`[${issueKey}] Transitioned to ${match.name}`);
}

async function addComment(issueKey, body) {
  await axios.post(
    `${BASE}/rest/api/3/issue/${issueKey}/comment`,
    {
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
      },
    },
    { headers: HEADERS }
  );
}

export async function closeJira(story, overall, liveUrl, workspaceDir) {
  const { key } = story;
  logger.info(`[${key}] Stage 8: Closing Jira — overall: ${overall}`);

  let commentBody;

  if (overall === 'PASS') {
    await transition(key, ['done', 'complete', 'closed']);
    commentBody = `✅ Pipeline complete — all QA tests passed.\n\nDeployment URL: ${liveUrl}\n\nThis story was fully automated: built, tested, deployed, and QA-verified with zero human intervention.`;
  } else {
    // Try "Bug Reported" or "In Review" or fall back to Done
    await transition(key, ['bug', 'reported', 'review', 'done', 'closed']);

    try {
      const report = await readFile(path.join(workspaceDir, 'bug-report.md'), 'utf8');
      commentBody = `⚠️ Pipeline complete with issues (${overall}).\n\nDeployment URL: ${liveUrl}\n\n--- Bug Report ---\n${report.slice(0, 3000)}`;
    } catch {
      commentBody = `⚠️ Pipeline complete with issues (${overall}).\n\nDeployment URL: ${liveUrl}`;
    }
  }

  await addComment(key, commentBody);
  logger.info(`[${key}] Stage 8: Jira closed and commented`);
}

export async function failJira(story, errorMessage) {
  const { key } = story;
  logger.info(`[${key}] Stage 8 (fail path): Closing Jira with error`);
  try {
    await transition(key, ['done', 'bug', 'closed', 'resolved']);
    await addComment(key, `❌ Pipeline failed for ${key}.\n\nError: ${errorMessage}\n\nThis story was processed automatically but encountered an unrecoverable error.`);
  } catch (err) {
    logger.error(`[${key}] Failed to close Jira on error path: ${err.message}`);
  }
}
