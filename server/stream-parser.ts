import { Readable } from 'node:stream';
import { createInterface, Interface as ReadlineInterface } from 'node:readline';
import { StreamJsonEventSchema } from '../src/shared/schemas';
import type { StreamJsonEvent } from '../src/shared/types';
import logger from './logger';

/** Result of parsing a single line from the CLI stdout stream. */
export type ParseResult =
  | { ok: true; event: StreamJsonEvent; raw: string }
  | { ok: false; error: string; raw: string };

/**
 * Parses a single line of stream-json output from the Claude CLI.
 *
 * Returns a typed ParseResult discriminated on `ok`. Malformed JSON
 * or unknown event shapes produce `{ ok: false }` with the raw line
 * preserved for trace capture.
 */
export function parseLine(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Empty line', raw };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Malformed JSON: ${message}`, raw };
  }

  const result = StreamJsonEventSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join('; ');
    return { ok: false, error: `Schema validation failed: ${issues}`, raw };
  }

  return { ok: true, event: result.data, raw };
}

/** Callback types for the StreamParser event handlers. */
export interface StreamParserCallbacks {
  /** Called for every raw line before parsing (for trace capture). */
  onRawLine: (line: string) => void;
  /** Called when a line parses successfully into a StreamJsonEvent. */
  onEvent: (event: StreamJsonEvent) => void;
  /** Called when a line fails to parse. */
  onParseError: (error: string, rawLine: string) => void;
}

/**
 * Creates a line-by-line stream parser for Claude CLI stdout.
 *
 * Uses `readline.createInterface` for robust line handling. Each line
 * is first passed to `onRawLine` for trace capture, then parsed via
 * `parseLine`. Valid events route to `onEvent`; invalid lines route
 * to `onParseError`.
 *
 * Returns the readline interface so the caller can listen for `'close'`.
 */
export function createStreamParser(
  input: Readable,
  callbacks: StreamParserCallbacks,
): ReadlineInterface {
  const rl = createInterface({ input, crlfDelay: Infinity });

  let lineCount = 0;

  rl.on('line', (line: string) => {
    lineCount++;
    callbacks.onRawLine(line);

    const result = parseLine(line);
    if (result.ok) {
      logger.debug({
        lineNum: lineCount,
        eventType: result.event.type,
        subtype: 'subtype' in result.event ? result.event.subtype : undefined,
      }, 'Stream parser: parsed event');
      callbacks.onEvent(result.event);
    } else {
      logger.debug({ lineNum: lineCount, error: result.error, rawPreview: line.substring(0, 200) }, 'Stream parser: skipping line');
      callbacks.onParseError(result.error, line);
    }
  });

  rl.on('close', () => {
    logger.info({ totalLines: lineCount }, 'Stream parser: stream closed');
  });

  return rl;
}
