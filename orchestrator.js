import { pollJira, pollJiraByKey } from './stages/01-jira-poll.js';
import { buildApp } from './stages/02-build-agent.js';
import { runTests } from './stages/03-test-agent.js';
import { runLocalQA } from './stages/03b-local-qa.js';
import { pushToGitHub } from './stages/04-github.js';
import { deployToVercel } from './stages/05-deploy.js';
import { runQA } from './stages/06-qa-agent.js';
import { sendReport } from './stages/07-email.js';
import { closeJira, failJira } from './stages/08-jira-close.js';
import { logger } from './utils/logger.js';

async function processStory(story) {
  const { key, workspaceDir } = story;
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`PIPELINE START: ${key}`);
  logger.info(`${'='.repeat(60)}`);

  let liveUrl = null;

  try {
    // Stage 2: Build
    const appDir = await buildApp(story);

    // Stage 3: Jest unit tests
    await runTests(story);

    // Stage 3b: Local browser QA — test in real browser before deploying
    const localQA = await runLocalQA(story, appDir);

    // Stage 4: Push to GitHub + open PR
    await pushToGitHub(story, appDir);

    // Stage 5: Deploy to Vercel
    liveUrl = await deployToVercel(story, appDir);

    // Stage 6: Vercel smoke test (quick check the URL loads)
    await runQA(story, liveUrl);

    // Stage 7: Email — use local QA report + screenshots (most reliable)
    await sendReport(story, localQA);

    // Stage 8: Close Jira
    await closeJira(story, localQA.analysis.overall, liveUrl, workspaceDir);

    logger.info(`PIPELINE COMPLETE: ${key} — ${localQA.analysis.overall}`);

  } catch (err) {
    logger.error(`PIPELINE ERROR [${key}]: ${err.message}`);
    logger.error(err.stack);
    await failJira(story, err.message);
  }
}

export async function runPipeline() {
  try {
    const stories = await pollJira();
    if (stories.length === 0) return;
    for (const story of stories) {
      await processStory(story);
    }
  } catch (err) {
    logger.error(`Poll error: ${err.message}`);
  }
}

export async function runForKey(jiraKey) {
  const story = await pollJiraByKey(jiraKey);
  if (!story) throw new Error(`Story ${jiraKey} not found or has no requirements.md`);
  await processStory(story);
}
