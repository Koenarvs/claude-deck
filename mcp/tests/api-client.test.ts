import { describe, it, expect } from 'vitest';
import { ApiError, ApiConnectionError } from '../src/api-client.js';

describe('ApiError', () => {
  it('includes status code and body in message', () => {
    const err = new ApiError(404, '{"error":"Not found"}');
    expect(err.statusCode).toBe(404);
    expect(err.body).toBe('{"error":"Not found"}');
    expect(err.message).toContain('404');
    expect(err.name).toBe('ApiError');
  });
});

describe('ApiConnectionError', () => {
  it('includes cause message', () => {
    const err = new ApiConnectionError('ECONNREFUSED');
    expect(err.cause_message).toBe('ECONNREFUSED');
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).toContain('127.0.0.1:4100');
    expect(err.name).toBe('ApiConnectionError');
  });
});
