# ── Stage 1: Install production + dev dependencies ──────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Build client (Vite) + server (tsc) ────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── Stage 3: Production runtime ────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# tini for proper PID 1 signal handling
RUN apk add --no-cache tini

# Copy built artifacts and production node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

EXPOSE 4100

ENV NODE_ENV=production
ENV DATA_DIR=/data

VOLUME /data

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/index.js"]
