import path from 'node:path';

export interface ServerEnv {
  port: number;
  dataDir: string;
  logLevel: string;
}

/**
 * Loads and validates server environment variables.
 * Returns typed config with validated PORT, DATA_DIR, and LOG_LEVEL.
 */
export function loadEnv(): ServerEnv {
  const rawPort = process.env['PORT'] ?? '4100';
  const port = parseInt(rawPort, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}. Must be between 1 and 65535.`);
  }

  const rawDataDir = process.env['DATA_DIR'] ?? './data';
  const dataDir = path.resolve(rawDataDir);

  const logLevel = process.env['LOG_LEVEL'] ?? 'info';

  return { port, dataDir, logLevel };
}
