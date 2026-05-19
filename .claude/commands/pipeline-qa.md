# pipeline-qa

Run just the QA stage (Stage 6) against any live URL, with a requirements file for context.

## Usage
`/pipeline-qa <live-url> <jira-key>`

Example: `/pipeline-qa https://my-app.vercel.app AI-3`

## What this does
1. Opens the URL in a headless Chromium browser via Playwright
2. Tests all acceptance criteria from the story's `requirements.md`
3. Takes screenshots at each key state
4. Generates a `bug-report.md` using Groq LLaMA 3.3 70B analysis
5. Saves everything to `workspace/<JIRA-KEY>/`

## Instructions

Parse the arguments from: **$ARGUMENTS**
- First token = URL
- Second token = Jira key

Run:
```bash
cd /home/clustox/Projects/Projectz/AI/pipeline && node -e "
import('dotenv/config').then(async () => {
  const { runQA } = await import('./stages/06-qa-agent.js');
  const { readFile } = await import('fs/promises');
  const path = await import('path');
  const url = process.argv[1];
  const key = process.argv[2];
  const workspaceDir = path.default.resolve('./workspace/' + key);
  const requirements = await readFile(workspaceDir + '/requirements.md', 'utf8').catch(() => 'No requirements found');
  const story = { key, requirements, workspaceDir };
  const result = await runQA(story, url);
  console.log('QA Overall:', result.analysis.overall);
  console.log('Report saved to:', result.reportPath);
}).catch(console.error)
" -- <URL> <KEY>
```

Replace `<URL>` and `<KEY>` with the parsed arguments.

Report back the overall QA status, the criteria table, and the path to the bug report.
