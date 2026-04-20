import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema, ZodError } from 'zod';

/**
 * Express middleware that validates req.body against a zod schema.
 * On parse failure, responds 400 with { error, issues }.
 * On success, replaces req.body with the parsed (and potentially transformed) data.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const zodError = result.error as ZodError;
      res.status(400).json({
        error: 'Validation failed',
        issues: zodError.issues,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Express middleware that validates req.query against a zod schema.
 * On parse failure, responds 400 with { error, issues }.
 * On success, replaces req.query with the parsed data.
 */
export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const zodError = result.error as ZodError;
      res.status(400).json({
        error: 'Validation failed',
        issues: zodError.issues,
      });
      return;
    }
    // Express 5 makes req.query a getter — store parsed data on res.locals
    (req as Record<string, unknown>)['validatedQuery'] = result.data;
    next();
  };
}
