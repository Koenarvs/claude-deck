import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { validateBody, validateQuery } from '../../../server/middleware/validate';
import type { Request, Response, NextFunction } from 'express';

function createMockRes(): Response & { _body: unknown } {
  const res = {
    statusCode: 200,
    _body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  } as unknown as Response & { _body: unknown };
  return res;
}

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    body: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

describe('validateBody', () => {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().min(0),
  });

  it('calls next on valid body', () => {
    const req = createMockReq({ body: { name: 'Alice', age: 30 } });
    const res = createMockRes();
    const next: NextFunction = vi.fn();

    validateBody(schema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toEqual({ name: 'Alice', age: 30 });
  });

  it('returns 400 on invalid body', () => {
    const req = createMockReq({ body: { name: '', age: -1 } });
    const res = createMockRes();
    const next: NextFunction = vi.fn();

    validateBody(schema)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    const body = res._body as { error: string; issues: unknown[] };
    expect(body.error).toBe('Validation failed');
    expect(body.issues).toBeDefined();
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('returns 400 when required field is missing', () => {
    const req = createMockReq({ body: { age: 25 } });
    const res = createMockRes();
    const next: NextFunction = vi.fn();

    validateBody(schema)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('replaces body with parsed data (strips extra fields)', () => {
    const req = createMockReq({ body: { name: 'Bob', age: 40, extra: 'field' } });
    const res = createMockRes();
    const next: NextFunction = vi.fn();

    validateBody(schema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    // Zod strips unknown keys by default
    expect(req.body).toEqual({ name: 'Bob', age: 40 });
  });
});

describe('validateQuery', () => {
  const schema = z.object({
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).optional(),
  });

  it('calls next on valid query', () => {
    const req = createMockReq({ query: { status: 'active' } as unknown as Request['query'] });
    const res = createMockRes();
    const next: NextFunction = vi.fn();

    validateQuery(schema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 400 on invalid query', () => {
    const req = createMockReq({ query: { limit: 'abc' } as unknown as Request['query'] });
    const res = createMockRes();
    const next: NextFunction = vi.fn();

    const strictSchema = z.object({
      limit: z.coerce.number().int().min(1),
    });

    validateQuery(strictSchema)(req, res, next);

    // 'abc' coerces to NaN which fails .int().min(1)
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });
});
