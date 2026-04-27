#!/usr/bin/env node
/**
 * Mock Claude CLI for integration tests.
 *
 * Reads a single stdin line (stream-json user message), then emits
 * canned stream-json events to stdout. Controlled via environment variables:
 *
 *   MOCK_CLI_SCENARIO:
 *     "basic"     — init → assistant(text) → result:success
 *     "tool_use"  — init → assistant(tool_use) → user(tool_result) → assistant(text) → result:success
 *     "malformed" — init → bad-json-line → assistant(text) → result:success
 *     "error"     — init → assistant(text) → exits with code 1
 *     "thinking"  — init → assistant(thinking+text) → result:success
 *     "slow"      — init → 200ms delay → assistant(text) → result:success
 *     "stderr"    — init → writes to stderr → assistant(text) → result:success
 *
 *   MOCK_CLI_SESSION_ID: override the session_id in init event
 *   MOCK_CLI_EXIT_CODE: override exit code (default 0 for non-error scenarios)
 */

const readline = require('readline');

const scenario = process.env.MOCK_CLI_SCENARIO || 'basic';
const sessionId = process.env.MOCK_CLI_SESSION_ID || 'mock-session-001';
const exitCodeOverride = process.env.MOCK_CLI_EXIT_CODE;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitInit() {
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools: ['Bash', 'Read', 'Write', 'Edit'],
    model: 'claude-sonnet-4-5-20250514',
  });
}

function emitAssistantText(text) {
  emit({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

function emitAssistantToolUse(id, name, input) {
  emit({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name, input }],
    },
  });
}

function emitToolResult(toolUseId, content) {
  emit({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  });
}

function emitAssistantThinking(thinking, text) {
  emit({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking },
        { type: 'text', text },
      ],
    },
  });
}

function emitResult(cost, turns) {
  emit({
    type: 'result',
    subtype: 'success',
    num_turns: turns || 1,
    session_id: sessionId,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runScenario() {
  // Read stdin (wait for the user prompt)
  const rl = readline.createInterface({ input: process.stdin });
  await new Promise((resolve) => {
    rl.on('line', () => {
      rl.close();
      resolve();
    });
    // If stdin is closed without a line, proceed anyway
    rl.on('close', resolve);
  });

  switch (scenario) {
    case 'basic':
      emitInit();
      emitAssistantText('Hello! I am the mock CLI responding to your prompt.');
      emitResult();
      break;

    case 'tool_use':
      emitInit();
      emitAssistantToolUse('tool-1', 'Bash', { command: 'echo hello' });
      emitToolResult('tool-1', 'hello\n');
      emitAssistantText('The command executed successfully.');
      emitResult(0.008, 2);
      break;

    case 'malformed':
      emitInit();
      process.stdout.write('this is not valid json at all{{{{\n');
      emitAssistantText('Valid message after malformed line.');
      emitResult();
      break;

    case 'error':
      emitInit();
      emitAssistantText('Starting some work...');
      process.exitCode = parseInt(exitCodeOverride || '1', 10);
      return; // Exit without result event

    case 'thinking':
      emitInit();
      emitAssistantThinking('Let me consider the best approach...', 'Based on my analysis, here is the answer.');
      emitResult();
      break;

    case 'slow':
      emitInit();
      await sleep(200);
      emitAssistantText('Delayed response.');
      emitResult();
      break;

    case 'stderr':
      emitInit();
      process.stderr.write('Warning: some debug output\n');
      emitAssistantText('Response after stderr output.');
      emitResult();
      break;

    default:
      process.stderr.write(`Unknown scenario: ${scenario}\n`);
      process.exit(2);
  }
}

runScenario().then(() => {
  const code = exitCodeOverride ? parseInt(exitCodeOverride, 10) : 0;
  process.exit(code);
}).catch((err) => {
  process.stderr.write(`Mock CLI error: ${err.message}\n`);
  process.exit(1);
});
