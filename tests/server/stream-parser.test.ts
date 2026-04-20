import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { parseLine, createStreamParser } from '../../server/stream-parser';
import type { StreamParserCallbacks } from '../../server/stream-parser';
import type { StreamJsonEvent } from '../../src/shared/types';

// ── parseLine unit tests ────────────────────────────────────────────────────

describe('parseLine', () => {
  it('parses a valid system/init event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'test-session',
      tools: ['Bash', 'Read'],
      model: 'claude-sonnet-4-5-20250514',
    });

    const result = parseLine(line);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe('system');
      if (result.event.type === 'system' && result.event.subtype === 'init') {
        expect(result.event.session_id).toBe('test-session');
        expect(result.event.tools).toEqual(['Bash', 'Read']);
      }
    }
  });

  it('parses a valid assistant event with text block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello world' }],
      },
    });

    const result = parseLine(line);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe('assistant');
    }
  });

  it('parses a valid assistant event with tool_use block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
    });

    const result = parseLine(line);
    expect(result.ok).toBe(true);
    if (result.ok && result.event.type === 'assistant') {
      expect(result.event.message.content[0]?.type).toBe('tool_use');
    }
  });

  it('parses a valid assistant event with thinking block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'Let me consider...' }],
      },
    });

    const result = parseLine(line);
    expect(result.ok).toBe(true);
  });

  it('parses a valid user event with tool_result', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'output' },
        ],
      },
    });

    const result = parseLine(line);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe('user');
    }
  });

  it('parses a valid result event', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.0042,
      num_turns: 1,
      session_id: 'test-session',
    });

    const result = parseLine(line);
    expect(result.ok).toBe(true);
    if (result.ok && result.event.type === 'result') {
      expect(result.event.total_cost_usd).toBe(0.0042);
      expect(result.event.num_turns).toBe(1);
    }
  });

  it('parses a valid compact_boundary event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { reason: 'context_limit' },
    });

    const result = parseLine(line);
    expect(result.ok).toBe(true);
  });

  it('returns error for malformed JSON', () => {
    const result = parseLine('this is not json{{{');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Malformed JSON');
      expect(result.raw).toBe('this is not json{{{');
    }
  });

  it('returns error for empty line', () => {
    const result = parseLine('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Empty line');
    }
  });

  it('returns error for whitespace-only line', () => {
    const result = parseLine('   \t  ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Empty line');
    }
  });

  it('returns error for valid JSON that does not match schema', () => {
    const result = parseLine('{"type": "unknown_event", "data": 42}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Schema validation failed');
    }
  });

  it('returns error for JSON object missing required fields', () => {
    const result = parseLine('{"type": "result"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Schema validation failed');
    }
  });

  it('preserves raw line in both success and failure cases', () => {
    const validLine = JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.01,
      num_turns: 1,
      session_id: 's1',
    });
    const validResult = parseLine(validLine);
    expect(validResult.raw).toBe(validLine);

    const invalidLine = 'not json';
    const invalidResult = parseLine(invalidLine);
    expect(invalidResult.raw).toBe(invalidLine);
  });

  it('handles line with leading/trailing whitespace', () => {
    const line = `  ${JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.01,
      num_turns: 1,
      session_id: 's1',
    })}  `;

    const result = parseLine(line);
    expect(result.ok).toBe(true);
  });
});

// ── createStreamParser integration tests ────────────────────────────────────

describe('createStreamParser', () => {
  let callbacks: StreamParserCallbacks;
  let rawLines: string[];
  let events: StreamJsonEvent[];
  let errors: Array<{ error: string; rawLine: string }>;

  beforeEach(() => {
    rawLines = [];
    events = [];
    errors = [];
    callbacks = {
      onRawLine: (line: string) => rawLines.push(line),
      onEvent: (event: StreamJsonEvent) => events.push(event),
      onParseError: (error: string, rawLine: string) => errors.push({ error, rawLine }),
    };
  });

  function createStreamFromLines(lines: string[]): Readable {
    const stream = new Readable({ read() {} });
    // Push all lines then end the stream
    for (const line of lines) {
      stream.push(line + '\n');
    }
    stream.push(null);
    return stream;
  }

  it('parses valid stream-json lines and calls onEvent for each', async () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's1',
        tools: ['Bash'],
        model: 'claude-sonnet-4-5-20250514',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.001,
        num_turns: 1,
        session_id: 's1',
      }),
    ];

    const stream = createStreamFromLines(lines);
    const rl = createStreamParser(stream, callbacks);

    await new Promise<void>((resolve) => rl.on('close', resolve));

    expect(rawLines).toHaveLength(3);
    expect(events).toHaveLength(3);
    expect(errors).toHaveLength(0);

    expect(events[0]?.type).toBe('system');
    expect(events[1]?.type).toBe('assistant');
    expect(events[2]?.type).toBe('result');
  });

  it('calls onRawLine for every line including malformed ones', async () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's1',
        tools: [],
        model: 'claude-sonnet-4-5-20250514',
      }),
      'this is bad json',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'After error' }] },
      }),
    ];

    const stream = createStreamFromLines(lines);
    const rl = createStreamParser(stream, callbacks);

    await new Promise<void>((resolve) => rl.on('close', resolve));

    // All 3 lines pass through onRawLine
    expect(rawLines).toHaveLength(3);
    // Valid events: 2 (init + assistant)
    expect(events).toHaveLength(2);
    // Parse errors: 1 (the bad json line)
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain('Malformed JSON');
    expect(errors[0]?.rawLine).toBe('this is bad json');
  });

  it('handles a stream with only malformed lines', async () => {
    const lines = ['not json 1', 'not json 2', '{invalid'];

    const stream = createStreamFromLines(lines);
    const rl = createStreamParser(stream, callbacks);

    await new Promise<void>((resolve) => rl.on('close', resolve));

    expect(rawLines).toHaveLength(3);
    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(3);
  });

  it('handles an empty stream', async () => {
    const stream = createStreamFromLines([]);
    const rl = createStreamParser(stream, callbacks);

    await new Promise<void>((resolve) => rl.on('close', resolve));

    expect(rawLines).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('handles malformed line surrounded by valid ones (spec edge case)', async () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's1',
        tools: [],
        model: 'claude-sonnet-4-5-20250514',
      }),
      '{{{{malformed}}}}',
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.001,
        num_turns: 1,
        session_id: 's1',
      }),
    ];

    const stream = createStreamFromLines(lines);
    const rl = createStreamParser(stream, callbacks);

    await new Promise<void>((resolve) => rl.on('close', resolve));

    // Both valid events still propagate
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('system');
    expect(events[1]?.type).toBe('result');
    // The malformed line is captured as an error
    expect(errors).toHaveLength(1);
    // All lines pass through raw callback
    expect(rawLines).toHaveLength(3);
  });

  it('handles unknown event type as parse error', async () => {
    const lines = [
      JSON.stringify({ type: 'custom_event', data: 'something' }),
    ];

    const stream = createStreamFromLines(lines);
    const rl = createStreamParser(stream, callbacks);

    await new Promise<void>((resolve) => rl.on('close', resolve));

    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(rawLines).toHaveLength(1);
  });
});
