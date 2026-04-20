import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { setupWss, broadcast } from '../../server/ws';
import type { ServerEvent } from '../../src/shared/events';

let server: http.Server | null = null;

function startServer(): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    setupWss(srv);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      server = srv;
      resolve({ port, server: srv });
    });
  });
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
});

describe('WebSocket hub', () => {
  it('responds to ping with ping', async () => {
    const { port } = await startServer();
    const client = await connectClient(port);

    const messagePromise = waitForMessage(client);
    client.send(JSON.stringify({ type: 'ping' }));

    const response = await messagePromise;
    expect(response).toEqual({ type: 'ping' });

    client.close();
  });

  it('delivers broadcast to subscribed client', async () => {
    const { port } = await startServer();
    const client = await connectClient(port);

    // Subscribe to all
    client.send(JSON.stringify({ type: 'subscribe', goals: 'all' }));

    // Wait a tick for subscription to register
    await new Promise((r) => setTimeout(r, 50));

    const messagePromise = waitForMessage(client);

    const event: ServerEvent = {
      type: 'goal:status',
      id: 'goal-1',
      status: 'active',
      current_session_id: 'sess-1',
    };
    broadcast(event);

    const response = await messagePromise;
    expect(response).toEqual(event);

    client.close();
  });

  it('does not deliver goal-specific events to unsubscribed clients', async () => {
    const { port } = await startServer();
    const client = await connectClient(port);

    // Subscribe to goal-2 only
    client.send(JSON.stringify({ type: 'subscribe', goals: ['goal-2'] }));
    await new Promise((r) => setTimeout(r, 50));

    // Broadcast for goal-1
    const event: ServerEvent = {
      type: 'goal:status',
      id: 'goal-1',
      status: 'active',
      current_session_id: null,
    };
    broadcast(event);

    // The client should NOT receive this event; wait briefly and verify
    let received = false;
    client.once('message', () => {
      received = true;
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toBe(false);

    client.close();
  });

  it('delivers goal-specific events to matching subscriber', async () => {
    const { port } = await startServer();
    const client = await connectClient(port);

    client.send(JSON.stringify({ type: 'subscribe', goals: ['goal-1'] }));
    await new Promise((r) => setTimeout(r, 50));

    const messagePromise = waitForMessage(client);

    const event: ServerEvent = {
      type: 'goal:status',
      id: 'goal-1',
      status: 'waiting',
      current_session_id: null,
    };
    broadcast(event);

    const response = await messagePromise;
    expect(response).toEqual(event);

    client.close();
  });
});
