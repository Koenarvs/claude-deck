# S3 — Deploy Configs + PWA Manifest

**Burst:** Support | **Depends on:** F0 merged | **Branch:** `feat/S3-deploy-pwa`

## Goal
Ship a production-runnable Docker image, a PM2 config for local long-running, and a PWA manifest so Chrome offers "Install app" on localhost.

## Spec references
- §12 deployment
- §14.4 S3

## Scope
- Create: `Dockerfile` — multi-stage: deps → build → runtime (node:22-alpine)
- Create: `docker-compose.yml` — single service, volume mount for `./data`, port 4100
- Create: `.dockerignore`
- Create: `ecosystem.config.cjs` — PM2 config
- Create: `public/manifest.webmanifest`
- Create: `public/icons/icon-192.png` (placeholder — use a simple generated icon via `sharp` at build time, or include a static PNG)
- Create: `public/icons/icon-512.png`
- Create: `public/icons/icon-maskable-512.png`
- Create: `public/favicon.svg` (simple text-based logo)
- Modify: `index.html` (verify `<link rel="manifest">` and `<meta name="theme-color">` present — F0 added these)
- Create: `tests/deploy/manifest.test.ts` — validates manifest shape

## Contracts consumed
- Nothing cross-cutting; this is infra

## Recommended task order
1. Create favicon.svg — simple dark gradient square with "CD" monogram.
2. Generate icons using `sharp` — write a small `scripts/generate-icons.ts` that produces 192/512/maskable from favicon.svg. Committed outputs live in `public/icons/`.
3. Create `manifest.webmanifest`:
```json
{
  "name": "claude-deck",
  "short_name": "deck",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```
4. TDD `manifest.test.ts`: parse JSON, validate with a zod schema matching PWA manifest requirements.
5. `Dockerfile`:
   ```dockerfile
   FROM node:22-alpine AS deps
   WORKDIR /app
   COPY package.json package-lock.json ./
   RUN npm ci

   FROM node:22-alpine AS build
   WORKDIR /app
   COPY --from=deps /app/node_modules ./node_modules
   COPY . .
   RUN npm run build

   FROM node:22-alpine AS runtime
   WORKDIR /app
   RUN apk add --no-cache tini
   COPY --from=build /app/dist ./dist
   COPY --from=build /app/node_modules ./node_modules
   COPY package.json ./
   EXPOSE 4100
   ENV NODE_ENV=production
   ENV DATA_DIR=/data
   VOLUME /data
   ENTRYPOINT ["/sbin/tini", "--"]
   CMD ["node", "dist/server/index.js"]
   ```
6. `docker-compose.yml`:
   ```yaml
   services:
     claude-deck:
       build: .
       ports:
         - "4100:4100"
       volumes:
         - ./data:/data
       restart: unless-stopped
   ```
7. `ecosystem.config.cjs`:
   ```js
   module.exports = {
     apps: [{
       name: 'claude-deck',
       script: 'dist/server/index.js',
       instances: 1,
       autorestart: true,
       watch: false,
       max_memory_restart: '1G',
       env: {
         NODE_ENV: 'production',
         PORT: 4100,
         DATA_DIR: './data',
       },
     }],
   };
   ```

## Production serving
For production mode, Express must serve the built React app from `dist/client/` at `/`. This requires a small addition to `server/app.ts` — if F0 didn't already add it, include in S3: a static-file middleware in prod only, with SPA-fallback for unknown routes that serves `index.html`.

File: `server/middleware/static-client.ts` — only mounts when `NODE_ENV === 'production'`.

## Acceptance criteria (spec §14.4 S3)
- [ ] `docker compose up --build` succeeds and serves on :4100
- [ ] `curl http://localhost:4100/api/health` returns 200 from the container
- [ ] `curl http://localhost:4100/` returns the built index.html from the container
- [ ] `npm run build && npx pm2 start ecosystem.config.cjs` runs
- [ ] Chrome on http://localhost:4100 offers "Install app" prompt (DevTools → Application → Manifest)
- [ ] Installed PWA opens in a standalone window with correct icon

## QA Checklist
- [ ] **QA-1:** Docker build completes without warnings (other than node deprecation)
- [ ] **QA-2:** Container-hosted health endpoint responds
- [ ] **QA-3:** Container-hosted SPA routes (e.g., /board) return the SPA shell (not 404)
- [ ] **QA-4:** PWA manifest validates (Lighthouse or manifest-validator)
- [ ] **QA-5:** Install-as-app creates a desktop shortcut with icon
- [ ] **QA-6:** PM2 config starts server; `pm2 logs claude-deck` shows "listening" message
- [ ] **QA-7:** Volume mount persists: add a goal, docker compose down, docker compose up → goal still there
- [ ] **QA-8:** No `any` types in new TS files

## Quality bar
- Dockerfile uses tini for signal handling; multi-stage to minimize image size; .dockerignore excludes node_modules, dist, data, .git
