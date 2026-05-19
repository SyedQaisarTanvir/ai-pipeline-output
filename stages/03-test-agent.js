import path from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execa } from 'execa';
import { groqCreate } from '../utils/groq-agent.js';
import { logger } from '../utils/logger.js';

async function runJest(workspaceDir) {
  try {
    const { stdout, stderr } = await execa(
      'npx', ['jest', 'tests/app.test.js', '--no-coverage', '--json'],
      { cwd: workspaceDir, timeout: 60000 }
    );
    return { success: true, output: stdout };
  } catch (err) {
    const output = err.stdout || err.stderr || err.message;
    return { success: false, output };
  }
}

function parseJestResults(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    return {
      passed: data.numPassedTests,
      failed: data.numFailedTests,
      total: data.numTotalTests,
      failures: data.testResults?.flatMap(r =>
        r.testResults?.filter(t => t.status === 'failed').map(t => t.fullName + ': ' + t.failureMessages?.join(' '))
      ) || [],
    };
  } catch {
    return { passed: 0, failed: 1, total: 1, failures: [jsonStr.slice(0, 2000)] };
  }
}

export async function runTests(story) {
  const { key, requirements, workspaceDir } = story;
  const testsDir = path.join(workspaceDir, 'tests');
  await mkdir(testsDir, { recursive: true });

  // Always write a fresh package.json — force CommonJS so Jest works
  await writeFile(path.join(workspaceDir, 'package.json'), JSON.stringify({
    name: key.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    version: '1.0.0',
    devDependencies: { jest: '^29', 'jest-environment-jsdom': '^29' },
  }, null, 2), 'utf8');

  // Jest config — jsdom + no transform needed for CommonJS test files
  await writeFile(path.join(workspaceDir, 'jest.config.json'), JSON.stringify({
    testEnvironment: 'jsdom',
    testMatch: ['**/tests/**/*.test.js'],
  }, null, 2), 'utf8');

  logger.info(`[${key}] Stage 3: Installing jest in workspace`);
  await execa('npm', ['install', '--save-dev', 'jest', 'jest-environment-jsdom'], {
    cwd: workspaceDir,
    timeout: 120000,
  });

  // Read the built app
  const appHtml = await readFile(path.join(workspaceDir, 'app', 'index.html'), 'utf8');

  logger.info(`[${key}] Stage 3: Generating unit tests via direct completion`);

  const testResponse = await groqCreate({
    messages: [
      {
        role: 'system',
        content: `You are a Jest test engineer. Write CommonJS Jest tests for a web app using jsdom.
Return ONLY the raw JavaScript test file content — no markdown, no explanation.
Start the file with: /* @jest-environment jsdom */
Use document.createElement, innerHTML, and event dispatching to test the DOM.
Import nothing — the app is loaded by setting document.body.innerHTML directly.`,
      },
      {
        role: 'user',
        content: `Write Jest tests for this todo app.\n\nRequirements summary:\n- Add todo via input+button or Enter key\n- Mark complete (strikethrough + opacity)\n- Delete todo\n- Counter shows remaining items\n- localStorage persistence\n\nApp source (index.html):\n${appHtml.slice(0, 6000)}\n\nWrite 5-8 meaningful tests covering the acceptance criteria. Return ONLY the .js file content.`,
      },
    ],
    temperature: 0.1,
    max_tokens: 3000,
  });

  let testCode = testResponse.choices[0].message.content || '';
  // Strip markdown fences if present
  const fenceMatch = testCode.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
  if (fenceMatch) testCode = fenceMatch[1].trim();

  await writeFile(path.join(workspaceDir, 'tests', 'app.test.js'), testCode, 'utf8');
  logger.info(`[${key}] Stage 3: Test file written (${testCode.length} chars)`);

  // Test-fix loop (max 3 iterations)
  let lastResult;
  for (let attempt = 1; attempt <= 3; attempt++) {
    logger.info(`[${key}] Stage 3: Running tests (attempt ${attempt})`);
    const result = await runJest(workspaceDir);
    const parsed = parseJestResults(result.output);
    lastResult = parsed;

    logger.info(`[${key}] Tests: ${parsed.passed} passed, ${parsed.failed} failed`);

    if (result.success || parsed.failed === 0) {
      logger.info(`[${key}] All tests passing`);
      break;
    }

    if (attempt < 3) {
      logger.info(`[${key}] Fixing test failures via direct completion...`);
      const currentTests = await readFile(path.join(workspaceDir, 'tests', 'app.test.js'), 'utf8').catch(() => testCode);
      const failureSummary = parsed.failures.slice(0, 3).join('\n').slice(0, 1000);
      const fixResponse = await groqCreate({
        messages: [
          { role: 'system', content: 'You are a Jest debugging expert. Fix the test file so all tests pass. Return ONLY the corrected test file content — no markdown, no explanation.' },
          { role: 'user', content: `Fix these test failures:\n${failureSummary}\n\nCurrent test file:\n${currentTests.slice(0, 3000)}\n\nApp HTML:\n${appHtml.slice(0, 3000)}` },
        ],
        temperature: 0.1,
        max_tokens: 3000,
      });
      let fixed = fixResponse.choices[0].message.content || '';
      const fixFence = fixed.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
      if (fixFence) fixed = fixFence[1].trim();
      await writeFile(path.join(workspaceDir, 'tests', 'app.test.js'), fixed, 'utf8');
    }
  }

  const summary = `Tests: ${lastResult.passed}/${lastResult.total} passed`;
  await writeFile(path.join(workspaceDir, 'test-results.txt'),
    `${summary}\n\nFailures:\n${lastResult.failures.join('\n') || 'None'}`, 'utf8');

  logger.info(`[${key}] Stage 3: ${summary}`);
  return lastResult;
}
