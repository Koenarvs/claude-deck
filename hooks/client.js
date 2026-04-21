#!/usr/bin/env node

/**
 * claude-deck hook client script.
 *
 * Invoked by the Claude CLI as a hook command. Reads the hook payload from
 * stdin, POSTs it to the claude-deck server, and exits with:
 *   0 — allow (tool use proceeds)
 *   2 — deny (tool use blocked, reason printed to stderr)
 *
 * Fail-open semantics: if the server is unreachable or returns an error,
 * this script exits 0 so the CLI is never blocked by a crashed dashboard.
 *
 * Zero external dependencies — uses only Node.js stdlib.
 *
 * Usage: node hooks/client.js <event-type>
 *   event-type: session-start | user-prompt-submit | pre-tool-use | post-tool-use | stop
 */

import http from 'node:http';

const PORT = parseInt(process.env.CLAUDE_DECK_PORT || '4100', 10);
const HOST = process.env.CLAUDE_DECK_HOST || '127.0.0.1';

// Timeout: 30 minutes for pre-tool-use (approval wait), 15 seconds for others
const PRE_TOOL_USE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15 * 1000;

/**
 * Reads all data from stdin and returns it as a string.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', function (chunk) {
      chunks.push(chunk);
    });
    process.stdin.on('end', function () {
      resolve(chunks.join(''));
    });
    process.stdin.on('error', function (err) {
      reject(err);
    });
  });
}

/**
 * POSTs JSON to the claude-deck server and returns the parsed response body.
 * @param {string} path - URL path (e.g., /api/hook/pre-tool-use)
 * @param {object} body - JSON body to send
 * @param {number} timeoutMs - Request timeout in milliseconds
 * @returns {Promise<object>}
 */
function httpPostJson(path, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var data = JSON.stringify(body);

    var options = {
      hostname: HOST,
      port: PORT,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    };

    var req = http.request(options, function (res) {
      var responseChunks = [];
      res.setEncoding('utf-8');
      res.on('data', function (chunk) {
        responseChunks.push(chunk);
      });
      res.on('end', function () {
        var rawBody = responseChunks.join('');
        try {
          resolve(JSON.parse(rawBody));
        } catch (_e) {
          resolve({ ok: true });
        }
      });
    });

    req.on('timeout', function () {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', function (err) {
      reject(err);
    });

    req.write(data);
    req.end();
  });
}

/**
 * Main entry point.
 */
async function main() {
  var eventType = process.argv[2];

  if (!eventType) {
    process.stderr.write('claude-deck hook: missing event type argument\n');
    process.exit(0); // fail-open
  }

  var isBlocking = eventType === 'pre-tool-use' || eventType === 'permission-request';
  var timeoutMs = isBlocking ? PRE_TOOL_USE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  var endpoint = '/api/hook/' + eventType;

  var payload;
  try {
    var raw = await readStdin();
    payload = JSON.parse(raw);
  } catch (_e) {
    process.stderr.write('claude-deck hook: failed to parse stdin as JSON\n');
    process.exit(0); // fail-open
  }

  // Add received_at timestamp
  payload.received_at = Date.now();

  try {
    var response = await httpPostJson(endpoint, payload, timeoutMs);

    if (isBlocking) {
      if (response && response.decision === 'deny') {
        var reason = response.reason || 'Denied by claude-deck';
        process.stderr.write(reason + '\n');
        process.exit(2);
      }
      // Allow (explicit or implicit)
      process.exit(0);
    }

    // Non-blocking hooks: always exit 0
    process.exit(0);
  } catch (err) {
    // Server unreachable or other error — fail open
    var message = err && err.message ? err.message : String(err);
    process.stderr.write('claude-deck hook unreachable: ' + message + '\n');
    process.exit(0);
  }
}

main();
