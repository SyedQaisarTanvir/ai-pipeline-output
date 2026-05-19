# pipeline-stage

Run a single pipeline stage in isolation for a given Jira key. Useful for debugging or re-running a failed stage without restarting the whole pipeline.

## Usage
`/pipeline-stage <stage-name> <jira-key>`

Available stage names: `build`, `test`, `github`, `deploy`, `qa`, `email`, `close`

Example: `/pipeline-stage qa AI-3`

## Instructions

Parse the arguments: **$ARGUMENTS**
- First token = stage name
- Second token = Jira key

The workspace for the story must already exist at `pipeline/workspace/<KEY>/`.

Map the stage name to the correct module and function, then run it. Use this mapping:

| stage | module | function |
|-------|--------|----------|
| build | ./stages/02-build-agent.js | buildApp(story) |
| test | ./stages/03-test-agent.js | runTests(story) |
| github | ./stages/04-github.js | pushToGitHub(story, appDir) — appDir = workspace/KEY/app |
| deploy | ./stages/05-deploy.js | deployToVercel(story, appDir) |
| qa | ./stages/06-qa-agent.js | runQA(story, liveUrl) — ask user for liveUrl if not in logs |
| email | ./stages/07-email.js | sendReport(story, qaResult) — requires qa to have run first |
| close | ./stages/08-jira-close.js | closeJira(story, overall, liveUrl, workspaceDir) |

To load the story context:
```bash
cd /home/clustox/Projects/Projectz/AI/pipeline && node -e "
import('dotenv/config').then(async () => {
  const { readFile } = await import('fs/promises');
  const path = await import('path');
  const key = '<KEY>';
  const workspaceDir = path.default.resolve('./workspace/' + key);
  const requirements = await readFile(workspaceDir + '/requirements.md', 'utf8');
  const story = { key, summary: key, requirements, workspaceDir };
  // Then call the appropriate stage function
  const { <FUNCTION> } = await import('./<MODULE>');
  const result = await <FUNCTION>(story, ...args);
  console.log('Done:', JSON.stringify(result, null, 2));
}).catch(console.error)
"
```

Fill in the module/function/args based on the stage requested. Report what the stage returned and whether it succeeded.
