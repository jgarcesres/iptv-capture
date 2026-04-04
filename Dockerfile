FROM node:22-slim

WORKDIR /app

COPY package.json ./

# Install deps and Chromium as root (for system packages),
# then set PLAYWRIGHT_BROWSERS_PATH so the node user can find them
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

RUN npm install --production \
    && npx playwright install --with-deps chromium \
    && chmod -R o+rx /opt/pw-browsers \
    && rm -rf /var/lib/apt/lists/*

COPY src/ ./src/

USER node

EXPOSE 8080

CMD ["node", "src/index.js"]
