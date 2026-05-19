import 'dotenv/config';
import cron from 'node-cron';
import { runPipeline } from './orchestrator.js';
import { logger } from './utils/logger.js';

logger.info('Zero Human Touch Pipeline starting...');
logger.info('Cron: every 5 minutes — polling Jira for ai-ready stories');

// Run once immediately on startup
runPipeline();

// Then every 5 minutes
cron.schedule('*/5 * * * *', () => {
  logger.info('Cron tick — polling Jira');
  runPipeline();
});
