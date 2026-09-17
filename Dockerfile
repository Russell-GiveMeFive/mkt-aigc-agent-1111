FROM node:22-slim

# ffmpeg：mock 视频合成 / 视频后处理；chromium：L2 HTML 截图引擎
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg chromium ca-certificates fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium

RUN corepack enable

WORKDIR /app

# 依赖（sharp/pi-ai 等）
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 源码与前端构建
COPY vite.config.js index.html* ./
COPY server ./server
COPY web ./web
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=8788
EXPOSE 8788

VOLUME ["/app/data"]
CMD ["node", "server/index.js"]
