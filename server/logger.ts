import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import pretty from 'pino-pretty';

const initialLevel = process.env['LOG_LEVEL'] ?? 'info';

/**
 * Daily-rotating NDJSON file sink: writes to <dir>/deck-YYYY-MM-DD.log, rolling
 * to a new file when the (local) date changes. Filenames carry the date so the
 * pruner can enforce retention without parsing file contents.
 */
export function createRotatingFileStream(dir: string): { write: (chunk: string) => void } {
  mkdirSync(dir, { recursive: true });
  let currentDate = '';
  let stream: WriteStream | null = null;
  return {
    write(chunk: string): void {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (date !== currentDate) {
        stream?.end();
        stream = createWriteStream(join(dir, `deck-${date}.log`), { flags: 'a' });
        currentDate = date;
      }
      stream!.write(chunk);
    },
  };
}

// Console sink: pretty in development, structured JSON in production. Per-stream
// levels are pinned to 'trace' so logger.level is the single verbosity control
// (runtime-settable from the Settings page via setLogLevel).
const consoleStream =
  process.env['NODE_ENV'] !== 'production' ? pretty({ colorize: true }) : process.stdout;

const streams = pino.multistream([{ level: 'trace', stream: consoleStream }]);

/** Application logger. Console always; file sink attached once DATA_DIR is known. */
const logger: pino.Logger = pino({ level: initialLevel }, streams);

let fileLoggingDir: string | null = null;

/**
 * Attach the rotating file sink under <dataDir>/logs. Called from index.ts once
 * the env is loaded (logger.ts must stay import-safe before that). Idempotent.
 */
export function enableFileLogging(dataDir: string): string {
  const dir = join(dataDir, 'logs');
  if (fileLoggingDir !== dir) {
    streams.add({ level: 'trace', stream: createRotatingFileStream(dir) });
    fileLoggingDir = dir;
  }
  return dir;
}

/** Runtime verbosity control — applied live when the logLevel setting changes. */
export function setLogLevel(level: string): void {
  if (Object.prototype.hasOwnProperty.call(logger.levels.values, level)) {
    logger.level = level;
  } else {
    logger.warn({ level }, 'Ignoring unknown log level');
  }
}

export default logger;
