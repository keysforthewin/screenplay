# Deps-only image: node_modules + system tools. The application source
# (src/, scripts/, data/, web/dist) is NOT baked in — it is bind-mounted from
# the host by docker-compose.yml, so a code change is just rsync + restart with
# no image rebuild. Rebuild this image only when dependencies change
# (package.json / package-lock.json) via `./deploy.sh --rebuild`.
#
# The SPA (web/dist) is built on the host by deploy.sh and mounted in; it is no
# longer built inside the image.
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache mongodb-tools ffmpeg
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
RUN mkdir -p /data/exports /data/backups
ENV PDF_EXPORT_DIR=/data/exports
ENV BACKUP_DIR=/data/backups
CMD ["node", "src/index.js"]
