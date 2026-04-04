FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY src/ ./src/

USER node

EXPOSE 8080

CMD ["node", "src/index.js"]
