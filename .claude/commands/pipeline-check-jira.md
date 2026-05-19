# pipeline-check-jira

Check Jira for all stories currently waiting to be picked up by the pipeline.

## What this does
Queries the Jira project for all issues with:
- Label: `ai-ready`
- Status: `To Do`

Reports the list with story key, title, and whether a `requirements.md` attachment is present.

## Instructions

Run this command to check Jira:

```bash
cd /home/clustox/Projects/Projectz/AI/pipeline && node -e "
import('dotenv/config').then(() => import('./utils/config.js')).then(async ({ config, jiraAuthHeader }) => {
  const axios = (await import('axios')).default;
  const jql = \`project = \${config.jira.projectKey} AND labels = 'ai-ready' AND status = 'To Do'\`;
  const res = await axios.get(config.jira.baseUrl + '/rest/api/3/search/jql', {
    headers: jiraAuthHeader(),
    params: { jql, fields: 'summary,attachment,labels', maxResults: 20 }
  });
  const issues = res.data.issues;
  if (!issues.length) { console.log('No ai-ready stories waiting.'); return; }
  issues.forEach(i => {
    const hasReq = (i.fields.attachment||[]).some(a => a.filename === 'requirements.md');
    console.log(\`\${i.key} | \${i.fields.summary} | requirements.md: \${hasReq ? 'YES' : 'MISSING'}\`);
  });
}).catch(console.error)
"
```

Display the results as a clean table and tell the user:
- How many stories are waiting
- Which ones have `requirements.md` (pipeline-ready) vs. missing it
- Suggest running `/pipeline-run <KEY>` to trigger one manually
