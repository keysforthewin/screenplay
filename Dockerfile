FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache mongodb-tools
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /data/exports /data/backups
ENV PDF_EXPORT_DIR=/data/exports
ENV BACKUP_DIR=/data/backups
CMD ["node", "src/index.js"]
