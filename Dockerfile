# Install all dependencies (including dev) for the build stage
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Install only locked production dependencies for runtime code that lives
# outside Next's standalone trace, such as the background worker.
FROM node:22-alpine AS prod-deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Build the app
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Dummy values for build-time page collection: the MCP route imports modules
# that exit when DATABASE_URL is unset. postgres.js/ioredis connect lazily,
# so nothing actually dials these during `next build`.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV REDIS_URL=redis://localhost:6379
ENV SESSION_SECRET=build-time-placeholder
RUN npm run build

# Bundle the migration runner and the background worker with esbuild so the
# runtime image needs no drizzle-kit or tsx. Everything is pure JS except
# sharp (native, already present in standalone's traced node_modules).
RUN npx --yes esbuild scripts/migrate.ts \
      --bundle --platform=node --target=node22 --format=cjs \
      --outfile=.next/standalone/migrate.js \
 && npx --yes esbuild src/worker.ts \
      --bundle --platform=node --target=node22 --format=cjs \
      --alias:@=./src --external:sharp \
      --outfile=.next/standalone/worker.js

# Production image. Plain Alpine + the distro nodejs package (stripped,
# shared-lib build) is markedly lighter than node:22-alpine and drops
# npm/yarn, which the runtime never uses. sharp is NAPI (ABI-stable).
FROM alpine:3.21 AS runner
WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/biker2000on/beez-trackz"
LABEL org.opencontainers.image.description="Beez Trackz - self-hosted beekeeping management app"
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache nodejs

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Prerender cache and upload storage need to be writable by the app user
RUN mkdir -p .next data/photos data/audio \
 && chown -R nextjs:nodejs .next data

# Next.js standalone output: server.js + traced node_modules, plus the bundled
# migrate.js. Drizzle SQL migrations ride along for migrate.js. Copy the full
# lockfile-resolved production dependency tree first so worker-only native
# imports keep their dependency closure without resolving different Next/React
# versions at image build time.
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
