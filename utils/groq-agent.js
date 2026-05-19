import Groq from 'groq-sdk';
import { writeFile, readFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execa } from 'execa';
import { config } from './config.js';
import { logger } from './logger.js';

const groq = new Groq({ apiKey: config.groq.apiKey });

// Models confirmed active on Groq as of May 2026
const ACTIVE_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

// Parse "Please try again in 5m15.36s" → milliseconds
function parseRetryAfter(message = '') {
  const min = message.match(/(\d+)m/)?.[1];
  const sec = message.match(/(\d+(?:\.\d+))s/)?.[1];
  const ms = (parseFloat(min || 0) * 60 + parseFloat(sec || 0)) * 1000;
  return ms > 0 ? ms + 3000 : 35000; // +3s buffer, default 35s
}

// Groq call — retries same model up to 3x on rate limit, then falls back
export async function groqCreate(params, attempt = 0) {
  const requestedModel = params.model || config.groq.model;

  // If requested model is decommissioned, immediately use fallback
  const primaryModel = ACTIVE_MODELS.includes(requestedModel)
    ? requestedModel
    : config.groq.fallbackModel;

  // Retry same model 3 times before switching to fallback
  const model = attempt < 3 ? primaryModel : config.groq.fallbackModel;

  const { model: _drop, ...rest } = params;

  try {
    logger.info(`  Groq: ${model} (attempt ${attempt + 1})`);
    return await groq.chat.completions.create({ ...rest, model });
  } catch (err) {
    const isRateLimit = err?.status === 429 || err?.error?.code === 'rate_limit_exceeded';
    const isDecommissioned = err?.error?.code === 'model_decommissioned';

    if (isDecommissioned) {
      // Remove this model from active list so we never try it again this session
      const idx = ACTIVE_MODELS.indexOf(model);
      if (idx !== -1) ACTIVE_MODELS.splice(idx, 1);
      logger.warn(`Model ${model} decommissioned — removed from active list. Using ${config.groq.fallbackModel}`);
      return groqCreate({ ...params, model: config.groq.fallbackModel }, 99);
    }

    if (isRateLimit && attempt < 5) {
      const waitMs = parseRetryAfter(err?.error?.message || '');
      const nextModel = attempt < 2 ? primaryModel : config.groq.fallbackModel;
      logger.warn(`Rate limit (${model}) — waiting ${Math.round(waitMs / 1000)}s, retrying with ${nextModel}`);
      await new Promise(r => setTimeout(r, waitMs));
      return groqCreate(params, attempt + 1);
    }

    throw err;
  }
}

// Tool implementations — all sandboxed to a workspace directory
function makeTools(workspaceDir) {
  return {
    write_file: async ({ file_path, content }) => {
      const fullPath = path.join(workspaceDir, file_path);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf8');
      return `Written: ${file_path}`;
    },
    read_file: async ({ file_path }) => {
      const fullPath = path.join(workspaceDir, file_path);
      if (!existsSync(fullPath)) return `File not found: ${file_path}`;
      return await readFile(fullPath, 'utf8');
    },
    list_directory: async ({ dir_path }) => {
      const fullPath = path.join(workspaceDir, dir_path || '.');
      if (!existsSync(fullPath)) return `Directory not found: ${dir_path}`;
      const entries = await readdir(fullPath, { withFileTypes: true });
      return entries.map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n');
    },
    run_command: async ({ command }) => {
      try {
        const { stdout, stderr } = await execa('bash', ['-c', command], {
          cwd: workspaceDir,
          timeout: 60000,
        });
        return (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).slice(0, 4000);
      } catch (err) {
        return `EXIT ${err.exitCode}: ${err.stderr || err.message}`.slice(0, 4000);
      }
    },
  };
}

// Tool schemas sent to Groq
const toolSchemas = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file inside the workspace directory',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Relative path inside workspace' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace directory',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Relative path inside workspace' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files in a workspace directory',
      parameters: {
        type: 'object',
        properties: {
          dir_path: { type: 'string', description: 'Relative directory path (default: root)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the workspace directory',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
];

/**
 * Run an agentic tool-use loop with Groq LLaMA 3.3 70B.
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} workspaceDir - all file/command tools are sandboxed here
 * @param {number} maxIterations
 * @returns {string} final text response from the agent
 */
// Keep message history under ~12k chars to avoid context overflow with LLaMA
function trimMessages(messages, maxChars = 12000) {
  let total = messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
  while (total > maxChars && messages.length > 2) {
    const removed = messages.splice(1, 2); // drop oldest exchange (keep first user msg)
    total -= removed.reduce((s, m) => s + JSON.stringify(m).length, 0);
  }
}

export async function runAgent({ systemPrompt, userMessage, workspaceDir, maxIterations = 20 }) {
  const tools = makeTools(workspaceDir);
  const messages = [{ role: 'user', content: userMessage }];

  for (let i = 0; i < maxIterations; i++) {
    logger.info(`Agent iteration ${i + 1}/${maxIterations}`);

    trimMessages(messages);

    let response;
    try {
      response = await groqCreate({
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools: toolSchemas,
        tool_choice: 'auto',
        temperature: 0.2,
      });
    } catch (err) {
      const isContextError = err?.error?.code === 'tool_use_failed' || err?.status === 400;
      if (isContextError && i < maxIterations - 1) {
        logger.warn(`Groq tool_use_failed on iteration ${i + 1} — trimming context and retrying`);
        messages.splice(1);
        messages.push({ role: 'user', content: 'Continue where you left off. Check existing files first with list_directory and read_file before writing.' });
        continue;
      }
      throw err;
    }

    const msg = response.choices[0].message;
    messages.push(msg);

    // No tool calls → agent is done
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || 'Done';
    }

    // Execute each tool call and collect results
    const toolResults = [];
    for (const call of msg.tool_calls) {
      const fn = call.function.name;
      let args;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        toolResults.push({ role: 'tool', tool_call_id: call.id, content: 'Error: invalid JSON arguments' });
        continue;
      }
      logger.info(`  Tool: ${fn}(${JSON.stringify(args).slice(0, 120)})`);

      const result = tools[fn] ? await tools[fn](args) : `Unknown tool: ${fn}`;
      logger.info(`  Result: ${String(result).slice(0, 200)}`);

      toolResults.push({
        role: 'tool',
        tool_call_id: call.id,
        content: String(result).slice(0, 3000),
      });
    }

    messages.push(...toolResults);
  }

  return 'Max iterations reached';
}
