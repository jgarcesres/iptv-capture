FROM node:22-slim

WORKDIR /app

COPY package.json ./

# Install deps and Chromium as root (for system packages),
# then set PLAYWRIGHT_BROWSERS_PATH so the node user can find them
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

COPY requirements.txt ./

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-venv \
    && python3 -m venv /opt/pyenv \
    && /opt/pyenv/bin/pip install --no-cache-dir -r requirements.txt \
    && npm install --production \
    && npx playwright install --with-deps chromium \
    && chmod -R o+rx /opt/pw-browsers \
    && rm -rf /var/lib/apt/lists/*

# Make pywidevine available via python3
ENV PATH="/opt/pyenv/bin:$PATH"

COPY src/ ./src/

USER node

EXPOSE 8080

CMD ["node", "src/index.js"]
