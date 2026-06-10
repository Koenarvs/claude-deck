import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createSystemRouter } from '../../../server/routes/system';

let server: http.Server | null = null;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')));
const goodFile = path.join(root, 'my-skill.md');
fs.writeFileSync(goodFile, '# hi');
const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-')));
const secret = path.join(outsideDir, 'secret.md');
fs.writeFileSync(secret, 'TOP SECRET');

function start(): Promise<number> {
  const router = createSystemRouter(undefined, { skillRoots: [root] });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const srv = http.createServer(app);
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      const a = srv.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    }),
  );
}
afterEach(() => { if (server) { server.close(); server = null; } });

describe('GET /api/skill-content path containment', () => {
  it('reads an .md file inside an allowed skill root', async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/skill-content?path=${encodeURIComponent(goodFile)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe('# hi');
  });

  it('403s a real .md file OUTSIDE every skill root (no .. needed)', async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/skill-content?path=${encodeURIComponent(secret)}`);
    expect(res.status).toBe(403);
  });

  it('rejects a non-.md file', async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/skill-content?path=${encodeURIComponent(path.join(root, 'x.txt'))}`);
    expect(res.status).toBe(400);
  });

  it('403s a traversal path that escapes the root', async () => {
    const port = await start();
    const evil = path.join(root, '..', path.basename(outsideDir), 'secret.md');
    const res = await fetch(`http://127.0.0.1:${port}/api/skill-content?path=${encodeURIComponent(evil)}`);
    expect(res.status).toBe(403);
  });
});
