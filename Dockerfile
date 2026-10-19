# Multi-stage build: one file produces both the API and the dashboard.
#
# The API runs TypeScript directly through tsx rather than compiling to JS.
# That keeps one source of truth - the CLI, the tests and the container all
# execute the same files, so a container-only bug cannot hide behind a build
# step the other paths skip.

# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm i -D tsx typescript --ignore-scripts

# ---------------------------------------------------------------------------
FROM node:24-alpine AS api
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json tsconfig.json ./
COPY src ./src
COPY server ./server

# Non-root: the API reaches a database and an object store, and there is no
# reason for it to be able to write to its own image.
RUN addgroup -S app && adduser -S app -G app -h /home/app \n && mkdir -p /home/app/.aws \n && chown -R app:app /app /home/app
USER app

EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "server/api.ts"]

# ---------------------------------------------------------------------------
FROM node:24-alpine AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --ignore-scripts
COPY web .
RUN npm run build

# ---------------------------------------------------------------------------
FROM nginx:alpine AS web
COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
