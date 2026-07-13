FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV MCP_HTTP=1
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
