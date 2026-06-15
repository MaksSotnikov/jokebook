# Single-stage image: builds @notes/core → @notes/web → @notes/server and runs
# the Fastify server, which also serves the built web client (apps/web/dist) on
# the same origin. Debian-slim (glibc) so @node-rs/argon2's prebuilt binary loads.
FROM node:20-slim

# pnpm via corepack; version is pinned by the root package.json "packageManager".
RUN corepack enable
WORKDIR /app

# Install deps first (this layer is cached unless a manifest or the lockfile
# changes). Every workspace package.json must be present for the lockfile to
# resolve, even ones we don't build here.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json ./packages/core/
COPY server/package.json ./server/
COPY apps/web/package.json ./apps/web/
COPY apps/app/package.json ./apps/app/
RUN pnpm install --frozen-lockfile

# Build: core first (web & server import its dist), then the web client, then
# the server bundle.
COPY . .
RUN pnpm --filter @notes/core build \
 && pnpm --filter @notes/web build \
 && pnpm --filter @notes/server build

ENV NODE_ENV=production
# The server reads PORT (Render injects it) and binds 0.0.0.0. DATABASE_URL and
# JWT_SECRET come from the environment (see render.yaml).
CMD ["node", "server/dist/index.js"]
