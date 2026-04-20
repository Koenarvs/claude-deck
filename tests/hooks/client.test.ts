import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const CLIENT_SCRIPT = path.resolve(__dirname, '../../hooks/client.js');

/** Spawns the hook client script with given args and stdin, returns exit code + stderr. */
function runClient(
  args: string[],
  stdin: string,
  env?: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLIENT_SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('hooks/client.js', () => {
  it('is valid JavaScript (passes node --check)', () => {
    // This will throw if the file has syntax errors
    execSync(`node --check "${CLIENT_SCRIPT}"`);
  });

  describe('with server unreachable', () => {
    it('exits 0 and prints warning to stderr for non-blocking hook', async () => {
      const result = await runClient(
        ['session-start'],
        JSON.stringify({ session_id: 'test-1' }),
        { CLAUDE_DECK_PORT: '19999' }, // unreachable port
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('claude-deck hook unreachable');
    });

    it('exits 0 and prints warning to stderr for pre-tool-use', async () => {
      const result = await runClient(
        ['pre-tool-use'],
        JSON.stringify({ session_id: 'test-2', tool_name: 'Bash' }),
        { CLAUDE_DECK_PORT: '19998' }, // unreachable port
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('claude-deck hook unreachable');
    });
  });

  describe('with missing event type', () => {
    it('exits 0 and prints error to stderr', async () => {
      const result = await runClient(
        [], // no event type
        JSON.stringify({ session_id: 'test-3' }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('missing event type');
    });
  });

  describe('with invalid stdin JSON', () => {
    it('exits 0 and prints error to stderr', async () => {
      const result = await runClient(
        ['session-start'],
        'not valid json {{{',
        { CLAUDE_DECK_PORT: '19997' },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('failed to parse stdin');
    });
  });

  describe('with mock server', () => {
    let server: http.Server;
    let serverPort: number;
    let nextResponse: { status: number; body: string } = { status: 200, body: '{"ok":true}' };

    beforeAll(async () => {
      await new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on('end', () => {
            res.writeHead(nextResponse.status, { 'Content-Type': 'application/json' });
            res.end(nextResponse.body);
          });
        });
        server.listen(0, () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            serverPort = addr.port;
          }
          resolve();
        });
      });
    });

    afterAll(() => {
      server.close();
    });

    it('exits 0 for session-start when server responds 200', async () => {
      nextResponse = { status: 200, body: '{"ok":true}' };

      const result = await runClient(
        ['session-start'],
        JSON.stringify({ session_id: 'mock-1' }),
        { CLAUDE_DECK_PORT: String(serverPort) },
      );

      expect(result.exitCode).toBe(0);
    });

    it('exits 0 for pre-tool-use when server allows', async () => {
      nextResponse = { status: 200, body: '{"decision":"allow"}' };

      const result = await runClient(
        ['pre-tool-use'],
        JSON.stringify({ session_id: 'mock-2', tool_name: 'Bash' }),
        { CLAUDE_DECK_PORT: String(serverPort) },
      );

      expect(result.exitCode).toBe(0);
    });

    it('exits 2 for pre-tool-use when server denies', async () => {
      nextResponse = { status: 200, body: '{"decision":"deny","reason":"not allowed"}' };

      const result = await runClient(
        ['pre-tool-use'],
        JSON.stringify({ session_id: 'mock-3', tool_name: 'Bash' }),
        { CLAUDE_DECK_PORT: String(serverPort) },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('not allowed');
    });

    it('exits 2 for pre-tool-use deny with default reason when none provided', async () => {
      nextResponse = { status: 200, body: '{"decision":"deny"}' };

      const result = await runClient(
        ['pre-tool-use'],
        JSON.stringify({ session_id: 'mock-4', tool_name: 'Write' }),
        { CLAUDE_DECK_PORT: String(serverPort) },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Denied by claude-deck');
    });

    it('exits 0 for stop hook', async () => {
      nextResponse = { status: 200, body: '{"ok":true}' };

      const result = await runClient(
        ['stop'],
        JSON.stringify({ session_id: 'mock-5' }),
        { CLAUDE_DECK_PORT: String(serverPort) },
      );

      expect(result.exitCode).toBe(0);
    });

    it('exits 0 for user-prompt-submit hook', async () => {
      nextResponse = { status: 200, body: '{"ok":true}' };

      const result = await runClient(
        ['user-prompt-submit'],
        JSON.stringify({ session_id: 'mock-6' }),
        { CLAUDE_DECK_PORT: String(serverPort) },
      );

      expect(result.exitCode).toBe(0);
    });

    it('exits 0 for post-tool-use hook', async () => {
      nextResponse = { status: 200, body: '{"ok":true}' };

      const result = await runClient(
        ['post-tool-use'],
        JSON.stringify({ session_id: 'mock-7', tool_name: 'Bash' }),
        { CLAUDE_DECK_PORT: String(serverPort) },
      );

      expect(result.exitCode).toBe(0);
    });
  });
});
