# Jarvis Admin — Roadmap PRD

**Project:** `github.com/alexberardi/jarvis-admin`
**Status:** MVP (settings management + service registration)
**Last Updated:** February 2026
**Companion doc:** [compose-creator.md](./compose-creator.md) — Docker management features

---

## 1. What This Document Is

This PRD defines the feature roadmap for jarvis-admin: which capabilities live here, which live in jarvis-installer, and the order they should be built.

**jarvis-installer** is the front door — a static configurator that gets users from zero to `docker compose up`. Once Jarvis is running, the installer's job is done.

**jarvis-admin** is the ongoing control plane — the app the user opens every day to manage, monitor, and configure their Jarvis instance. It is the difference between Jarvis being a developer project and a product.

---

## 2. Boundary: Installer vs Admin

| Concern | jarvis-installer | jarvis-admin |
|---------|-----------------|--------------|
| When used | Once, at install time | Ongoing, after install |
| Runs where | Browser (static SPA on GitHub Pages) | Local network (containerized, part of the stack) |
| Hardware profiling | User self-reports GPU/RAM in wizard | Auto-detects from host (nvidia-smi, /proc) |
| Module selection | Initial choices baked into install command | Toggle modules on/off at any time |
| Config generation | Generates initial `.env` + compose flags | Reads/writes live config, restarts services |
| Service management | None — just generates the bootstrap | Full lifecycle: start, stop, restart, update |
| Auth | None (static site, no backend) | Single-user password + JWT |
| Install script | Owns `install.sh` and generates the curl command | Does not touch install flow |
| Service registry | Owns `service-registry.json` definition | Consumes it to render config UI |
| Docker compose | Owns the top-level `docker-compose.yml` | Mounted read-only, shells out for profile mgmt |

**Handoff point:** The installer generates config and runs `install.sh`. The install script starts the stack including jarvis-admin. From that moment on, the user interacts with jarvis-admin exclusively.

---

## 3. Current State (What's Built)

### Working Features
- **Network discovery** — Automatically finds `jarvis-config-service` on the local network (localhost scan, then subnet scan via WebRTC IP detection). Cached in localStorage.
- **Authentication** — Login via `jarvis-auth`, superuser gate, JWT with auto-refresh, axios interceptor for 401 handling.
- **Settings management** — Browse all service settings aggregated from `jarvis-config-service`. Search, filter, inline edit with type-aware editors (string, int, float, bool, json). Grouped by category.
- **Service registration** — Register services with config-service and auth. Health probing, key rotation, host:port configuration.
- **Theme** — Dark/light mode toggle, persisted to localStorage, color tokens matching jarvis-node-mobile.

### Current Architecture
```
Frontend-only SPA (no backend of its own)
├── Talks to jarvis-auth (port 7701) for authentication
├── Talks to jarvis-config-service (port 7700) for settings + service registry
└── Network discovery finds these automatically
```

### What's Not Built Yet
- No backend (Node.js API server)
- No Docker socket integration
- No container lifecycle management (start/stop/restart)
- No health dashboard or resource monitoring
- No log viewer
- No module enable/disable UI
- No first-run setup wizard
- No Dockerfile / container packaging
- No tests

---

## 4. Deployment Model

**Same codebase, two deployment modes** (like Nabu Casa for Home Assistant):

### Self-hosted (default)
- User runs the full Jarvis stack on their own hardware
- jarvis-admin runs as a container in the Docker Compose stack
- All data stays local, no cloud dependency
- User is responsible for updates, backups, hardware

### Cloud-hosted (future)
- We host the infrastructure — LLM inference, services, storage
- User gets the same admin UI at a hosted URL
- No Docker management needed (we handle that)
- Subscription model for compute costs
- Same open-source codebase, no feature gating

**Implementation note:** For now, build everything for self-hosted. The cloud variant is a deployment concern, not a code concern. The admin UI should abstract over "how services are managed" so that swapping Docker socket calls for a hosted API is a backend change, not a frontend rewrite.

---

## 5. Feature Roadmap

### Phase 1: Backend + Container Management (next)

The admin currently runs as a pure frontend SPA that talks directly to jarvis-auth and jarvis-config-service. Phase 1 adds its own backend, enabling Docker integration and proper container management.

**Backend (Node.js + Fastify):**
- [ ] Health endpoint (`/health`) — unauthenticated, for Docker health checks and monitoring
- [ ] API server with Docker socket integration via `dockerode`
- [ ] Service registry parser (consume `service-registry.json` from jarvis-installer)
- [ ] Container status endpoint (running/stopped/error/restarting via Docker API)
- [ ] Container restart endpoint
- [ ] Config read/write proxied through backend (currently direct from browser)
- [ ] Module enable/disable via `docker compose --profile <x> up/stop`
- [ ] Basic auth middleware (JWT validation)
- [ ] Dockerfile + integration into Jarvis compose stack

**Frontend:**
- [ ] Dashboard page — grid of service health cards (status, uptime, quick actions)
- [ ] Module management page — toggle cards for optional services with dependency warnings
- [ ] Config drift detection — soft warnings when `.env` values don't match registry schema defaults (warn, don't block)
- [ ] System info bar — host info, Jarvis version, total resource usage

**Details:** See [compose-creator.md](./compose-creator.md) sections 4–7 for full specs on Docker integration, service registry schema, API design, and config storage.

### Phase 2: Observability

**Log viewer (integrated with jarvis-logs):**
- [ ] Per-service log viewer with tail + search
- [ ] Query logs from `jarvis-logs` service (port 7702) — not just Docker container logs
- [ ] Severity filtering and highlighting
- [ ] Time range selection
- [ ] Real-time streaming via WebSocket
- [ ] Download as text
- [ ] Cross-service log correlation (trace a request across services)

**Resource monitoring:**
- [ ] Per-service CPU and memory (from Docker stats API)
- [ ] GPU utilization and VRAM (nvidia-smi, if present)
- [ ] Disk usage per service image
- [ ] Simple time-series charts (last hour/day — not a full Grafana replacement)

**Service detail pages:**
- [ ] Individual service page with: config, logs, resource usage, restart history
- [ ] Health check history (up/down timeline)

### Phase 3: Lifecycle Management

**First-run setup wizard:**
- [ ] Detect first run (no `admin.json` or `firstRun: true` flag)
- [ ] Hardware auto-detection (GPU, VRAM, CPU, RAM)
- [ ] Home Assistant discovery (mDNS or manual URL + token test)
- [ ] Module selection with dependency resolution
- [ ] Admin password setup
- [ ] Review + launch (write config, start services)

**Updates:**
- [ ] Check for newer images on GHCR (compare digests)
- [ ] Per-service or "Update All"
- [ ] Pull → recreate container (preserving config)
- [ ] Show release notes from GitHub releases API
- [ ] Rollback to previous image

**Backup / Restore:**
- [ ] Export: download all env files + profiles.json + admin.json as zip
- [ ] Import: upload zip, validate schema, apply config, restart affected services

### Phase 4: Intelligence

**Log analytics:**
- [ ] Query logs using natural language (route through jarvis-llm if available)
- [ ] Error pattern detection — surface recurring errors automatically
- [ ] Performance insights — identify slow services, high-latency requests

**Alerting:**
- [ ] Service crash notifications (browser push, or local webhook)
- [ ] Resource threshold alerts (GPU temp, disk full, memory pressure)
- [ ] Configurable alert rules per service

**Command testing:**
- [ ] Send test voice commands through the pipeline from the admin UI
- [ ] See the full trace: STT → command router → service → response → TTS
- [ ] Useful for debugging "Jarvis didn't understand me" issues

### Phase 5: Ecosystem

- [ ] CLI wrapper (`jarvis up`, `jarvis status`, `jarvis config`) sharing config with admin
- [ ] Community module browser (install third-party Jarvis commands)
- [ ] Portainer / CasaOS / Umbrel app template generation
- [ ] Multi-host management (Pi Zero endpoints on other machines)

---

## 6. Config Drift Detection

When the admin reads a service's config, it compares values against the service registry schema. If a value doesn't match any of the defined options (for `select` fields) or falls outside `min`/`max` (for `number` fields), the UI shows a soft warning:

```
⚠ GPU_LAYERS is set to 150 (max defined in registry: 99)
  This may be a custom value. Jarvis won't override it.
```

**Rules:**
- Warnings are informational only — never block saves or prevent the service from starting
- Custom values are valid; the registry defines recommendations, not hard constraints
- Warn on: out-of-range numbers, values not in select options, missing required fields
- Don't warn on: fields not defined in the registry (users can add custom env vars)

---

## 7. Integration Points

| System | How admin integrates | Direction |
|--------|---------------------|-----------|
| jarvis-auth | JWT login, superuser validation | admin → auth |
| jarvis-config-service | Settings CRUD, service registry | admin → config |
| jarvis-logs | Log querying, real-time streaming | admin → logs |
| Docker Engine | Container lifecycle, stats, image pulls | admin → socket |
| service-registry.json | Schema for config UI rendering | installer → admin (mounted file) |
| docker-compose.yml | Profile management for modules | installer → admin (mounted file) |
| GitHub Releases API | Update checking, release notes | admin → github |

---

## 8. Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Backend framework | Fastify | Schema validation aligns with config schema approach; faster than Express |
| Docker client | dockerode | Most mature Node.js Docker library; supports streaming |
| Profile management | Shell out to `docker compose` CLI | Docker API doesn't understand Compose profiles natively |
| Container filtering | `com.jarvis.managed=true` label | Only manage Jarvis containers, ignore everything else |
| Auth | Single-user, bcrypt + JWT, httpOnly cookie | Simple, secure, no OAuth overhead for local use |
| State management | TanStack Query (already in use) | Caching, mutations, invalidation — already proven in current settings UI |
| Log source | jarvis-logs service (primary), Docker logs (fallback) | jarvis-logs has structured data, cross-service correlation |

---

## 9. Success Criteria

- After initial install, all Jarvis management happens through this UI — no terminal needed
- Adding a new service = adding a `service-registry.json` entry — zero frontend code changes
- Admin container: < 100MB image, < 50MB runtime memory
- Settings changes take effect within 5 seconds (write + restart if needed)
- Config drift warnings catch 100% of out-of-schema values without false positives on custom env vars
- Log viewer loads last 100 lines in under 1 second
- The same frontend works for both self-hosted and cloud-hosted deployments
