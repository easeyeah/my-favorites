# my-favorites 自建端镜像 —— 与云端同一套代码，按 env 区分形态（技术方案 §3/§8）
# 红线：镜像 <=250MB（node:24-alpine 运行时基线，bundle 级增量），运行内存 <300MB，支持 linux/arm64（AGENTS.md）

# ---------- 基础：依赖与源码 ----------
FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable && pnpm config set store-dir /app/.pnpm-store
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/extension/package.json apps/extension/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ai/package.json packages/ai/package.json
RUN pnpm fetch

FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production

# ---------- dev 目标：整仓安装 + watch 热重载（docker-compose.dev.yml 使用） ----------
FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /app/.pnpm-store /app/.pnpm-store
RUN pnpm config set store-dir /app/.pnpm-store
COPY . .
RUN pnpm install --frozen-lockfile --prefer-offline
CMD ["pnpm", "--filter", "@mf/server", "dev"]

# ---------- 生产目标：构建层打 bundle，运行层无 pnpm/无 node_modules（红线 <200MB） ----------
FROM base AS build
ENV NODE_ENV=development
COPY --from=deps /app/.pnpm-store /app/.pnpm-store
RUN pnpm config set store-dir /app/.pnpm-store
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared packages/shared
COPY packages/ai packages/ai
COPY apps/server apps/server
RUN pnpm install --frozen-lockfile --prefer-offline
RUN pnpm --filter @mf/server build

FROM node:24-alpine AS prod
WORKDIR /app
COPY --from=build /app/apps/server/dist/index.js ./dist/index.js

ENV PORT=3000 \
    MF_FORM=self-hosted \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
