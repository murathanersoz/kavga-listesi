# Kavga Listesi — single container: server serves the built client.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY client/package.json client/
COPY shared/package.json shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @kavga/client build && pnpm --filter @kavga/server build

FROM node:22-alpine
RUN corepack enable && adduser -D -u 10001 app
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY shared/package.json shared/
RUN pnpm install --frozen-lockfile --prod --filter @kavga/server --filter @kavga/shared
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
COPY --from=build /app/shared shared
RUN mkdir -p /data && chown app /data
USER app
ENV PORT=3001 KAVGA_DB=/data/kavga.db NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/dist/server/src/index.js"]
