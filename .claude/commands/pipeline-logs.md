# pipeline-logs

Show the most recent pipeline execution logs.

## Usage
`/pipeline-logs` — shows last 100 lines
`/pipeline-logs 200` — shows last N lines

## Instructions

The argument (if provided) is the number of lines: **$ARGUMENTS**

Default to 100 lines if no argument given.

Run:
```bash
tail -n ${LINES:-100} /home/clustox/Projects/Projectz/AI/pipeline/logs/pipeline.log
```

Then also show a summary:
- How many pipeline runs completed today (count lines with "PIPELINE COMPLETE")
- How many errors (count lines with "PIPELINE ERROR")  
- The last deployment URL seen (grep for "Live at https://")
- Current time so the user knows how fresh the logs are

If the log file doesn't exist yet, tell the user: "No logs yet — start the pipeline with `node index.js` from the pipeline directory."
