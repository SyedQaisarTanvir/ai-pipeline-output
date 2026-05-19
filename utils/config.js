import 'dotenv/config';

export const config = {
  jira: {
    baseUrl: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    apiToken: process.env.JIRA_API_TOKEN,
    projectKey: process.env.JIRA_PROJECT_KEY,
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
  },
  vercel: {
    token: process.env.VERCEL_TOKEN,
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    fallbackModel: process.env.GROQ_MODEL_FALLBACK || 'llama3-8b-8192',
    buildModel: process.env.GROQ_BUILD_MODEL || 'llama-3.3-70b-versatile',
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO,
  },
};

export function jiraAuthHeader() {
  const token = Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString('base64');
  return { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' };
}
