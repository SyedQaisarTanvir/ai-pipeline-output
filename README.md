# Zero Human Touch AI Pipeline

A fully automated pipeline that takes Jira stories from backlog to deployed app — no human steps in between.

**Flow:** Jira story → AI builds app → Jest tests → Local browser QA → GitHub PR → Vercel deploy → Smoke test → Email report → Jira closed

---

## Architecture

```
index.js (cron every 5 min)
    └── orchestrator.js
          ├── Stage 1:  Jira poll      — find ai-ready stories, download requirements.md
          ├── Stage 2:  Build agent    — Groq LLaMA 3.3-70B generates the web app
          ├── Stage 3:  Jest tests     — Groq generates + runs unit tests
          ├── Stage 3b: Local QA       — Playwright (visible browser) tests localhost
          ├── Stage 4:  GitHub         — create branch, commit files, open PR
          ├── Stage 5:  Vercel deploy  — two-step file upload + deployment
          ├── Stage 6:  Smoke test     — confirm live URL responds
          ├── Stage 7:  Email report   — Resend email with screenshots + bug report
          └── Stage 8:  Jira close     — transition ticket to Done with QA result
```

---

## Prerequisites

- Node.js 18+
- `npm install`
- `npx playwright install chromium`
- All environment variables in `.env` (see below)

---

## Environment Variables

Create a `.env` file in the project root:

```env
# Jira
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_PROJECT_KEY=KAN

# GitHub
GITHUB_TOKEN=ghp_your_classic_pat          # needs repo + contents:write
GITHUB_OWNER=YourGitHubUsername
GITHUB_REPO=your-output-repo

# Vercel
VERCEL_TOKEN=vcp_your_vercel_token

# Groq
GROQ_API_KEY=gsk_your_groq_api_key
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_MODEL_FALLBACK=llama-3.1-8b-instant
GROQ_BUILD_MODEL=llama-3.3-70b-versatile

# Email (Resend)
RESEND_API_KEY=re_your_resend_key
EMAIL_FROM=onboarding@resend.dev
EMAIL_TO=you@example.com
```

> **Groq note:** The build stage requires llama-3.3-70b-versatile (requirements can exceed 6K tokens). Free tier: 100K tokens/day. Use a fresh account or paid plan if you hit limits.

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browser
npx playwright install chromium

# 3. Copy and fill in environment variables
cp .env.example .env   # then edit .env

# 4. In Jira: label a story "ai-ready" and attach a requirements.md attachment
```

### Jira setup

1. Create a story in your project (e.g. project key `KAN`)
2. Add the label **`ai-ready`** to the story
3. Attach a file named **`requirements.md`** to the story with a detailed spec
4. The pipeline transitions tickets through: `To Do → In Progress → Done`

---

## Running

```bash
# Start the cron loop (polls Jira every 5 minutes)
npm start

# Run immediately for a specific Jira key
node index.js --key KAN-11

# Watch mode (restart on file changes)
npm run dev
```

---

## Claude Code Skills

Five `/pipeline-*` skills are included in `.claude/commands/`:

| Skill | What it does |
|-------|-------------|
| `/pipeline-run` | Run the full pipeline now (or for a specific key) |
| `/pipeline-check-jira` | List all `ai-ready` stories |
| `/pipeline-qa` | Run only the local QA stage against an existing app |
| `/pipeline-logs` | Tail the pipeline log file |
| `/pipeline-stage` | Run a single stage in isolation |

---

## Pipeline Stages

### Stage 1 — Jira Poll
- Queries `GET /rest/api/3/search/jql` for stories labeled `ai-ready`
- Downloads `requirements.md` attachment from each story
- Transitions the story to **In Progress**
- Creates a local workspace directory per story

### Stage 2 — Build Agent
- Single Groq completion call with the full requirements
- Uses `llama-3.3-70b-versatile` exclusively (build model)
- Validates output: must contain `<style>`, `<script>`, `localStorage`, `addEventListener`, min 2000 chars
- Up to 3 retry attempts if validation fails
- Writes `index.html` to the workspace

### Stage 3 — Jest Tests
- Groq generates a Jest test file for the built app
- Creates a CommonJS `package.json` (not ESM) in the test workspace to avoid Jest/ESM conflicts
- Runs `jest` and collects results
- Up to 3 fix attempts on test failures

### Stage 3b — Local Browser QA
- Spins up a minimal Node HTTP server on a random port (3000–4000)
- Launches a **visible** Chromium browser (`headless: false`, `slowMo: 350ms`)
- Takes 8 screenshots: initial load, typing, after-add, Enter-key add, mark complete, delete, mobile 375px, reload (localStorage persistence)
- Groq LLaMA analyzes observations against requirements → generates `bug-report.md`
- Returns `PASS | PARTIAL | FAIL` overall result

### Stage 4 — GitHub
- Creates a branch `story/<jira-key>`
- Commits `index.html` + `bug-report.md`
- Opens a pull request with QA summary in the description

### Stage 5 — Vercel Deploy
- Two-step file upload: pre-upload each file (POST `/v2/files` with SHA256), then create deployment
- Health check accepts any non-5xx response (handles Vercel 308 redirects)
- Health check failure is non-fatal — pipeline continues

### Stage 6 — Smoke Test
- Opens the live Vercel URL in a headful browser
- Detects Vercel login wall (auth interstitial) and logs a warning without crashing
- Takes one screenshot of the live deployment

### Stage 7 — Email Report
- Sends an HTML email via Resend with:
  - Overall QA status (PASS / PARTIAL / FAIL)
  - Test criteria table from bug report
  - All local QA screenshots as inline attachments
  - Link to the GitHub PR and live Vercel URL

### Stage 8 — Jira Close
- Transitions the story to **Done**
- Posts a comment with the QA result, live URL, and GitHub PR link
- On pipeline error: transitions to a failed status and posts the error message

---

## Rate Limit Handling

The Groq wrapper (`utils/groq-agent.js`) handles rate limits automatically:

1. Parses the exact wait time from the 429 error message (`"Please try again in 5m15s"`)
2. Retries the same model up to 3 times
3. Falls back to `llama-3.1-8b-instant` on the 4th attempt
4. Detects decommissioned models and removes them from the active list permanently

---

## Output Structure

Each Jira story creates a workspace under `./workspace/<jira-key>/`:

```
workspace/KAN-11/
├── index.html          # built web app
├── bug-report.md       # QA analysis
└── screenshots/
    ├── local-01-initial.png
    ├── local-02-typing.png
    ├── local-03-after-add.png
    ├── local-04-enter-key.png
    ├── local-05-complete.png
    ├── local-06-delete.png
    ├── local-07-mobile.png
    ├── local-08-reload.png
    └── vercel-01-live.png
```

---

## Tech Stack

| Tool | Purpose |
|------|---------|
| Groq LLaMA 3.3-70B | App generation, test generation, QA analysis |
| Playwright | Local browser QA + screenshots |
| `@octokit/rest` | GitHub branch/commit/PR |
| Vercel REST API v13 | Deployment |
| Resend | Email delivery |
| Jira REST API v3 | Story polling + status transitions |
| `node-cron` | 5-minute polling schedule |
| `winston` | Structured logging |
