# Stage 1: build the static React app.
# Debian-based (glibc) build image: the native toolchain binaries (TypeScript 7,
# rolldown) resolved in package-lock.json match it on both amd64 and arm64.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: serve it with nginx, which also reverse-proxies /api (HTTP and
# WebSocket) to the backend so the browser only ever talks to one origin.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
