# pahe-watcher — runs the watcher + web GUI with Playwright/Chromium preinstalled.
# The Playwright base image ships the browser and all system libs.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    BROWSER_MODE=headless \
    BROWSER_PROFILE_DIR=/data/browser-profile \
    STATE_PATH=/data/state.json

# Persist state + browser profile + credentials via volumes.
VOLUME ["/data", "/app/credentials"]

EXPOSE 8787

# Simple healthcheck against the status endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8787) +'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
