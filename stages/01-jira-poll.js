import axios from 'axios';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { config, jiraAuthHeader } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const BASE = config.jira.baseUrl;
const HEADERS = jiraAuthHeader();

async function searchStories() {
  const jql = `project = ${config.jira.projectKey} AND labels = "ai-ready" AND status = "To Do"`;
  const res = await axios.get(`${BASE}/rest/api/3/search/jql`, {
    headers: HEADERS,
    params: { jql, fields: 'summary,status,attachment,labels', maxResults: 10 },
  });
  return res.data.issues || [];
}

async function downloadAttachment(attachmentId) {
  const res = await axios.get(`${BASE}/rest/api/3/attachment/content/${attachmentId}`, {
    headers: HEADERS,
    responseType: 'text',
  });
  return res.data;
}

async function transitionToInProgress(issueKey) {
  // Get available transitions
  const res = await axios.get(`${BASE}/rest/api/3/issue/${issueKey}/transitions`, {
    headers: HEADERS,
  });
  const transitions = res.data.transitions;
  const inProgress = transitions.find(t =>
    t.name.toLowerCase().includes('progress') || t.name.toLowerCase().includes('in progress')
  );
  if (!inProgress) {
    logger.warn(`No "In Progress" transition found for ${issueKey}. Available: ${transitions.map(t => t.name).join(', ')}`);
    return;
  }
  await axios.post(
    `${BASE}/rest/api/3/issue/${issueKey}/transitions`,
    { transition: { id: inProgress.id } },
    { headers: HEADERS }
  );
  logger.info(`${issueKey} transitioned to In Progress`);
}

export async function pollJira() {
  logger.info('Polling Jira for ai-ready stories...');
  const issues = await searchStories();

  if (issues.length === 0) {
    logger.info('No new stories found.');
    return [];
  }

  logger.info(`Found ${issues.length} story/stories: ${issues.map(i => i.key).join(', ')}`);

  const stories = [];

  for (const issue of issues) {
    const key = issue.key;
    const summary = issue.fields.summary;
    const attachments = issue.fields.attachment || [];

    const reqFile = attachments.find(a => a.filename === 'requirements.md');
    if (!reqFile) {
      logger.warn(`${key} has no requirements.md attachment — skipping`);
      continue;
    }

    // Transition immediately so cron won't pick it up again
    await transitionToInProgress(key);

    // Download requirements.md
    logger.info(`Downloading requirements.md from ${key}`);
    const requirements = await downloadAttachment(reqFile.id);

    // Save to workspace
    const workspaceDir = path.resolve(`./workspace/${key}`);
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, 'requirements.md'), requirements, 'utf8');

    stories.push({ key, summary, requirements, workspaceDir });
    logger.info(`${key} ready for pipeline`);
  }

  return stories;
}

// Manual trigger by key — used by pipeline-run skill
export async function pollJiraByKey(issueKey) {
  const res = await axios.get(`${BASE}/rest/api/3/issue/${issueKey}`, {
    headers: HEADERS,
    params: { fields: 'summary,status,attachment,labels' },
  });
  const issue = res.data;
  const attachments = issue.fields.attachment || [];
  const reqFile = attachments.find(a => a.filename === 'requirements.md');
  if (!reqFile) return null;

  const requirements = await downloadAttachment(reqFile.id);
  const workspaceDir = path.resolve(`./workspace/${issueKey}`);
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(workspaceDir, 'requirements.md'), requirements, 'utf8');

  return { key: issueKey, summary: issue.fields.summary, requirements, workspaceDir };
}
