# Stage 1: build
FROM node:26-alpine3.22 AS builder
WORKDIR /usr/src/h5p-service

# The H5P client library fetch needs tar.
RUN apk add --no-cache tar

# --ignore-scripts, then fetch explicitly. The postinstall hook cannot run here
# because `scripts/` is not in the image yet, and installing with scripts
# enabled would also run install hooks from the whole dependency tree. Fetching
# as its own step keeps the dependency layer cached when only a script changes,
# and makes the checksum verification visible in the build log.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --ignore-scripts

COPY scripts/ ./scripts/
RUN npm run fetch:h5p-core

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: runtime
FROM node:26-alpine3.22
WORKDIR /usr/src/h5p-service

# Supplied by the image workflow. Also settable on a plain `docker build` so a
# locally built image is stamped the same way. The workflow additionally passes
# these as --label, which overrides the LABEL below; both are kept so neither
# path produces an unstamped image.
ARG VERSION=0.0.0-dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="LibreTexts H5P Service" \
      org.opencontainers.image.description="H5P hosting and playback for LibreTexts activities" \
      org.opencontainers.image.vendor="LibreTexts" \
      org.opencontainers.image.source="https://github.com/LibreTexts/h5p-service" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

COPY package.json package-lock.json ./
# --ignore-scripts skips the postinstall fetch so the client libraries are
# copied from the builder instead of downloaded twice. Nothing untars in this
# stage as a result, which is why `tar` is not installed here.
RUN npm ci --no-audit --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /usr/src/h5p-service/dist ./dist
COPY --from=builder /usr/src/h5p-service/h5p ./h5p
COPY public/ ./public/
COPY LICENSE ./

# Serving is read-only: content and uploads go to S3 and Mongo, and
# express-fileupload runs without `useTempFiles`, so no writable directory is
# needed. Enabling `useTempFiles` would require a writable path owned by uid
# 1000 before this line.
USER node

EXPOSE 5100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
