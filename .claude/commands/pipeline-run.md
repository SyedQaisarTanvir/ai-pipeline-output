# pipeline-run

Manually trigger the Zero Human Touch Pipeline for a specific Jira story key, bypassing the cron timer.

## Usage
`/pipeline-run AI-123`

## What this does
1. Fetches the Jira story and downloads its `requirements.md` attachment
2. Runs all 8 pipeline stages in sequence: Build → Test → GitHub PR → Vercel Deploy → QA → Email → Jira Close
3. Streams logs to terminal so you can watch it live

## Instructions

The user has provided a Jira story key as the argument: **$ARGUMENTS**

Run the following in the pipeline directory:

```bash
cd /home/clustox/Projects/Projectz/AI/pipeline && node -e "
import('./orchestrator.js').then(m => m.runForKey('$ARGUMENTS')).catch(console.error)
"
```

Stream the output and report back:
- Which stages completed successfully
- The live deployment URL (from Stage 5)
- The QA overall result (PASS / PARTIAL / FAIL)
- Any errors encountered

If no argument was provided, ask the user: "Which Jira story key should I run? (e.g. AI-1)"
