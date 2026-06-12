# Install all dependencies (including dev) for the build stage
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Build the app
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Bundle the migration runner with esbuild so the runtime image needs no
# drizzle-kit or tsx. drizzle-orm and postgres are pure JS, so bundle them
# fully — no externals — into a single migrate.js inside .next/standalone.
RUN npx --yes esbuild scripts/migrate.ts \
      --bundle --platform=node --target=node22 --format=cjs \
      --outfile=.next/standalone/migrate.js

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

# Prerender cache and photo storage need to be writable by the app user
RUN mkdir -p .next data/photos \
 && chown -R nextjs:nodejs .next data

# Next.js standalone output: server.js + traced node_modules, plus the
# bundled migrate.js. Drizzle SQL migrations ride along for migrate.js.
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
