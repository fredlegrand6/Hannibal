# Hannibal always-on server (see server/README.md). Build from the repo root:
#   docker build -t hannibal-server -f server/Dockerfile .
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-requests ffmpeg tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY electron/services electron/services
COPY server server
ENV TZ=Europe/Amsterdam HANNIBAL_PY=python3 HANNIBAL_FFMPEG=ffmpeg
CMD ["node", "server/hannibal-server.js"]
