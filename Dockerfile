FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /data/exports
ENV PDF_EXPORT_DIR=/data/exports
CMD ["node", "src/index.js"]
