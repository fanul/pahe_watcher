# pahe-watcher — runs the watcher + web GUI with Playwright/Chromium preinstalled.
# The Playwright base image ships the browser and all system libs.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

# The base image's own bundled Node predates node:sqlite's minimum
# (>=22.5.0 — src/core/store.js uses DatabaseSync; see ARCHITECTURE.md
# "Requirements"). Installed explicitly rather than trusting whatever a
# given Playwright image tag happens to ship, since that's changed under
# us before (the previous pin, v1.49.1-jammy, predated the requirement
# entirely).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# This app launches with `channel: "chrome"` by default (real Google
# Chrome, not Playwright's own bundled Chromium build — see browser.js /
# llAdGate.js / oiilaGate.js) since a real Chrome install is what actually
# passes Cloudflare Turnstile reliably. The Playwright base image only
# ships its own Chromium; the "chrome" channel needs installing separately.
RUN npx playwright install --with-deps chrome

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
