import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * Proves that listening on the loopback host yields an address bound to
 * 127.0.0.1 (not 0.0.0.0). This is the contract index.ts must satisfy by
 * passing env.bindHost to server.listen.
 */
function listenOn(host: string): Promise<{ address: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, host, () => {
      const addr = srv.address() as AddressInfo;
      resolve({ address: addr.address, close: () => srv.close() });
    });
  });
}

describe('server bind host', () => {
  it('binds to 127.0.0.1 when host is loopback', async () => {
    const { address, close } = await listenOn('127.0.0.1');
    expect(address).toBe('127.0.0.1');
    close();
  });

  it('binds to 0.0.0.0 only when explicitly requested', async () => {
    const { address, close } = await listenOn('0.0.0.0');
    expect(address).toBe('0.0.0.0');
    close();
  });
});
