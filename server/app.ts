import express from 'express';
import cors from 'cors';
import path from 'node:path';
import type { Router, Request, Response, NextFunction } from 'express';
import healthRouter from './routes/health';
import logger from './logger';
import { createApiAuthMiddleware } from './middleware/auth';

export interface AppRouters {
  /** Additional routers to mount under /api. */
  apiRouters?: Router[];
  /** Shared-secret auth config; token null = no-op (loopback dev). */
  auth?: { token: string | null };
}

/**
 * Creates and configures the Express application.
 * Applies CORS (localhost only), JSON body parsing, route mounts,
 * 404 handler, and error handler.
 *
 * @param options - Optional additional routers to mount (e.g. scheduled tasks).
 */
export function createApp(options?: AppRouters): express.Express {
  const app = express();

  // CORS — localhost origins only
  app.use(
    cors({
      origin: [
        'http://localhost:5173',
        'http://localhost:4100',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:4100',
      ],
    }),
  );

  // JSON body parser with 10MB limit
  app.use(express.json({ limit: '10mb' }));

  // Shared-secret gate on all /api routes (no-op when no token configured).
  // Mounted before the routers; /api/health is exempt inside the middleware.
  app.use('/api', createApiAuthMiddleware({ token: options?.auth?.token ?? null }));

  // Mount API routes
  app.use('/api', healthRouter);

  // Mount any additional API routers
  if (options?.apiRouters) {
    for (const router of options.apiRouters) {
      app.use('/api', router);
    }
  }

  // Serve built frontend in production. Same-origin avoids CORS and lets one
  // port (4100) expose both API and UI on LAN.
  if (process.env['NODE_ENV'] === 'production') {
    const clientDir = path.resolve(process.cwd(), 'dist', 'client');
    app.use(express.static(clientDir));
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  }

  // 404 handler for unmatched routes
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Express 5 error handler — async errors are caught automatically.
  // Express 5 uses 4-param middleware for error handling.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message, stack: err.stack }, 'Unhandled server error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
