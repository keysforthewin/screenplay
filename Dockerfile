FROM node:22-alpine AS web-build
WORKDIR /build
ARG WEB_BASE_PATH=/
ENV WEB_BASE_PATH=$WEB_BASE_PATH
COPY package.json package-lock.json* ./
RUN npm ci
COPY web ./web
RUN npm run build:web

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache mongodb-tools
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY --from=web-build /build/web/dist ./web/dist
RUN mkdir -p /data/exports /data/backups
ENV PDF_EXPORT_DIR=/data/exports
ENV BACKUP_DIR=/data/backups
CMD ["node", "src/index.js"]
