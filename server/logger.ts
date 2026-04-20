import pino from 'pino';

const level = process.env['LOG_LEVEL'] ?? 'info';

/** Application logger. Pretty-prints in development; structured JSON in production. */
const logger: pino.Logger =
  process.env['NODE_ENV'] !== 'production'
    ? pino({
        level,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      })
    : pino({ level });

export default logger;
