# jarvis-admin

Web admin dashboard for managing Jarvis services. Superuser-only access.

React 19 + Vite frontend served by a Fastify backend that proxies to jarvis-auth, jarvis-config-service, and jarvis-settings-server.

## Quick Start

```bash
# Install dependencies
npm install
cd server && npm install && cd ..

# Development (frontend on :5173, backend on :3000)
npm run dev          # frontend
cd server && npm run dev  # backend

# Production build
npm run build
cd server && npm run build
node server/dist/index.js  # serves frontend + API on :3000
```

## Docker

```bash
docker build -t jarvis-admin .
docker run -p 7711:7711 jarvis-admin
```

The container includes a healthcheck against `GET /health`.

## Architecture

- **Frontend**: React 19, React Router, TanStack Query, Tailwind CSS v4
- **Backend**: Fastify 5, proxies auth/settings/services to upstream Jarvis services
- **Service discovery**: Automatically resolves service URLs from `jarvis-config-service` at startup

## Dependencies

| Service | Required | Purpose |
|---------|----------|---------|
| jarvis-config-service (7700) | Yes | Service discovery |
| jarvis-auth (7701) | Yes | User authentication (superuser only) |
| jarvis-settings-server (7708) | Yes | Settings CRUD |

## Uninstall

If the installer was interrupted or you need a clean reinstall, run these commands to fully remove all Jarvis state:

```bash
# 1. Remove generated config files
rm -rf ~/.jarvis

# 2. Stop and remove all Jarvis containers
docker ps -a --filter "name=jarvis" -q | xargs -r docker rm -f

# 3. Remove Docker volumes (PostgreSQL data, Redis, etc.)
docker volume ls --filter "name=jarvis" -q | xargs -r docker volume rm

# 4. Remove the Docker network
docker network rm jarvis 2>/dev/null

# 5. (Optional) Remove pulled images to free disk space
docker images --filter "reference=ghcr.io/alexberardi/jarvis-*" -q | xargs -r docker rmi
docker images --filter "reference=postgres" -q | xargs -r docker rmi
docker images --filter "reference=redis" -q | xargs -r docker rmi
docker images --filter "reference=eclipse-mosquitto" -q | xargs -r docker rmi
docker images --filter "reference=grafana/*" -q | xargs -r docker rmi
```

After cleanup, re-run the installer from scratch.

## Tests

```bash
cd server && npm test
```
