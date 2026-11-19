# Deploy container: satu proses, disk persisten (SQLite), tanpa serverless.
# Sync penuh bisa berjalan beberapa menit (SSI kadang lambat), jadi jangan taruh di
# balik batas 60–300 detik fungsi serverless.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

# tsx tidak dipakai di runtime: Node 24 menjalankan .ts langsung (strip-only).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY web ./web
COPY tsconfig.json ./

# Volume: /data agar database tidak hilang saat container diganti.
ENV HOST=0.0.0.0 \
    PORT=4321 \
    MONEV_DB=/data/monev.db

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/cli.ts", "serve"]
