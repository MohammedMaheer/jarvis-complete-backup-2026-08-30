# Jarvis Admin — Product Requirements Document

**Project:** `github.com/alexberardi/jarvis-admin`
**Stack:** React + TypeScript + Vite
**Status:** Scaffold (3 commits, boilerplate Vite template)
**Last Updated:** February 2026

---

## 1. Overview

Jarvis Admin is a lightweight, containerized web dashboard that ships as part of the Jarvis voice assistant Docker Compose stack. It serves as the single control plane for users to configure, enable/disable, and monitor all Jarvis microservices — eliminating the need to manually edit `.env` files, YAML, or run CLI commands.

**Core thesis:** This is the difference between Jarvis being a "developer project" and a "product." The admin UI is the first thing a user opens after `docker compose up`.

---

## 2. Users & Context

**Primary user:** Self-hoster running Jarvis via Docker Compose on a local network. Technically literate enough to run `docker compose up` but shouldn't need to touch config files after that.

**Deployment context:**
- Runs as `jarvis-admin` service inside the Jarvis Compose stack
- Accessed via browser on local network (e.g., `http://jarvis.local:8080`)
- Single-user/household; no multi-tenancy needed
- Communicates with sibling containers via Docker socket or Docker API

---

## 3. Goals

| Priority | Goal |
|----------|------|
| P0 | First-run setup wizard that gets a new user from zero to working Jarvis |
| P0 | Per-service environment variable configuration with validation |
| P0 | Enable/disable optional service modules (profiles) |
| P1 | Service health monitoring and status dashboard |
| P1 | Restart individual services after config changes |
| P2 | Log viewer (per-service, tail + search) |
| P2 | Update management (pull new images, restart) |
| P3 | Backup/restore of configuration |

---

## 4. Architecture

### 4.1 Container Design

```
jarvis-admin (single container)
├── Frontend: React + TypeScript (Vite build, served as static files)
├── Backend: Node.js API server (Express or Fastify)
└── Mounts:
    ├── /var/run/docker.sock (read/write — Docker API access)
    ├── /app/config/ (bind mount to host config directory)
    └── /app/compose/ (read-only mount of docker-compose.yml)
```

The backend is the critical piece — the React frontend cannot talk to Docker directly. The backend:
- Reads/writes `.env` files and service config
- Communicates with the Docker Engine API via the mounted socket
- Manages Compose profiles (start/stop optional services)
- Streams container logs via Docker API

### 4.2 Config Storage

All user configuration lives in a single directory on the host, bind-mounted into the admin container:

```
jarvis-config/
├── .env                    # Global env vars (shared across services)
├── services/
│   ├── llm.env             # LLM service overrides
│   ├── ocr.env             # OCR service overrides
│   ├── recipes.env         # Recipes service overrides
│   └── ...
├── profiles.json           # Which optional modules are enabled
└── admin.json              # Admin UI settings (auth, theme, etc.)
```

The `docker-compose.yml` references these via `env_file` directives. The admin UI reads/writes these files through the backend API.

### 4.3 Service Registry

The admin needs to know what services exist and how to present them. Define a `service-registry.json` that ships with the compose stack:

```json
{
  "services": {
    "llm-service": {
      "displayName": "Language Model",
      "description": "Core LLM inference engine (Llama 3.1 8B)",
      "category": "core",
      "profile": null,
      "configSchema": {
        "MODEL_NAME": {
          "type": "select",
          "label": "Model",
          "options": ["llama-3.1-8b", "llama-3.2-3b", "mistral-7b"],
          "default": "llama-3.1-8b",
          "description": "Which model to load for inference"
        },
        "QUANTIZATION": {
          "type": "select",
          "label": "Quantization",
          "options": ["q4_k_m", "q5_k_m", "q8_0", "f16"],
          "default": "q4_k_m",
          "description": "Lower = less VRAM, slightly lower quality"
        },
        "GPU_LAYERS": {
          "type": "number",
          "label": "GPU Layers",
          "min": 0,
          "max": 99,
          "default": -1,
          "description": "-1 for all layers on GPU"
        }
      }
    },
    "ocr-service": {
      "displayName": "OCR / Document Scanning",
      "description": "Tiered OCR pipeline for recipe scanning and document processing",
      "category": "optional",
      "profile": "ocr",
      "dependencies": [],
      "configSchema": {
        "OCR_TIER": {
          "type": "select",
          "label": "Default OCR Tier",
          "options": ["tesseract", "easyocr", "cloud-llm"],
          "default": "tesseract"
        }
      }
    },
    "recipes": {
      "displayName": "Jarvis Recipes",
      "description": "Recipe management app with OCR import",
      "category": "optional",
      "profile": "recipes",
      "dependencies": ["ocr-service"],
      "configSchema": { }
    }
  },
  "categories": {
    "core": { "label": "Core Services", "description": "Always running — the foundation of Jarvis" },
    "optional": { "label": "Optional Modules", "description": "Enable what you need" }
  }
}
```

This schema-driven approach means adding a new service to the admin UI = adding an entry to this JSON. No frontend code changes required.

---

## 5. Feature Specifications

### 5.1 First-Run Setup Wizard (P0)

**Trigger:** Admin detects no `admin.json` or a `firstRun: true` flag.

**Steps:**

1. **Welcome** — Brief intro, what Jarvis is, what this wizard does.
2. **Hardware Detection** — Backend auto-detects:
   - GPU availability (nvidia-smi or Docker GPU runtime)
   - Available VRAM
   - CPU cores / RAM
   - Recommends GPU vs CPU profile based on findings
3. **Home Assistant** — Optional integration:
   - Auto-discover via mDNS/Zeroconf, or manual URL entry
   - Test connection with provided long-lived access token
   - Pull entity list for command training context
4. **Module Selection** — Checklist of optional modules with descriptions. Dependencies auto-resolved (enabling Recipes auto-enables OCR with a note).
5. **Authentication** — Set admin password (or generate one). Shown once, stored hashed.
6. **Review & Launch** — Summary of choices. "Start Jarvis" button writes config and triggers `docker compose --profile <selected> up -d` for optional services.

### 5.2 Service Configuration (P0)

**UI:** Settings page with services grouped by category (Core / Optional). Each service expands to show its config fields, rendered from `configSchema`.

**Field types to support:**
- `text` — free text input with optional regex validation
- `number` — numeric input with min/max
- `select` — dropdown from predefined options
- `boolean` — toggle switch
- `secret` — password-style field (masked, with reveal toggle)
- `url` — URL input with connection test button

**Behavior:**
- Fields show current value from the service's `.env` file
- Unsaved changes are visually indicated (yellow dot or similar)
- "Save & Restart" button writes the env file and restarts only that service
- "Save" without restart is also available (takes effect on next restart)
- Validation runs client-side (from schema) and server-side before write
- Show which env vars map to which fields for transparency (collapsible "Advanced" view showing raw env)

### 5.3 Module Management (P0)

**UI:** Toggle cards for each optional module.

**Behavior:**
- Toggle ON: Pulls image if needed (show progress), starts service with correct profile
- Toggle OFF: Stops and removes container, optionally removes image to free disk space
- Dependency resolution: Can't disable OCR if Recipes is enabled — show warning/confirmation
- Show disk space used by each module's image
- Status indicator: Running / Stopped / Error / Pulling

### 5.4 Health Dashboard (P1)

**UI:** Landing page after setup. Grid of service cards.

**Per service:**
- Status: Running / Stopped / Restarting / Error (via Docker API container inspect)
- Uptime
- Resource usage: CPU %, memory (via Docker stats API)
- Quick actions: Restart, View Logs, Configure

**System-wide:**
- GPU utilization and VRAM usage (if GPU present)
- Total memory / disk usage
- Host uptime
- Jarvis version

### 5.5 Log Viewer (P2)

**UI:** Accessible per-service from the dashboard or a dedicated logs page.

**Features:**
- Tail last N lines (default 100) with auto-scroll
- Real-time streaming via WebSocket (Docker API log stream)
- Service selector dropdown to switch between services
- Basic text search/filter
- Severity highlighting (ERROR in red, WARN in yellow, etc.)
- Download full log as text file

### 5.6 Updates (P2)

**UI:** Update page or notification badge on dashboard.

**Behavior:**
- Check for newer images on registry (compare digests)
- One-click "Update All" or per-service update
- Pull new image → recreate container (preserving config)
- Show changelog/release notes if available (fetch from GitHub releases API)
- Rollback: keep previous image tag, offer "revert to previous version"

---

## 6. API Design (Backend)

RESTful API served by the admin backend. All endpoints require auth token (except initial setup).

```
# Health & System
GET    /api/system/info          # GPU, CPU, RAM, disk, host info
GET    /api/system/health        # Aggregate health check

# Services
GET    /api/services             # List all services with status
GET    /api/services/:id         # Single service detail
GET    /api/services/:id/config  # Current config values
PUT    /api/services/:id/config  # Update config (writes env file)
POST   /api/services/:id/restart # Restart service container
GET    /api/services/:id/logs    # Fetch logs (query: lines, since)
WS     /api/services/:id/logs/stream  # WebSocket log stream
GET    /api/services/:id/stats   # Live resource usage

# Modules (optional services)
GET    /api/modules              # List with enabled/disabled state
POST   /api/modules/:id/enable   # Pull + start
POST   /api/modules/:id/disable  # Stop + remove

# Setup
GET    /api/setup/status         # Is first-run complete?
POST   /api/setup/detect         # Run hardware detection
POST   /api/setup/test-ha        # Test Home Assistant connection
POST   /api/setup/complete       # Finalize setup, write config, start services

# Auth
POST   /api/auth/login           # Get session token
POST   /api/auth/change-password # Update password

# Updates
GET    /api/updates/check        # Check for newer images
POST   /api/updates/pull/:id     # Pull new image for service
POST   /api/updates/apply/:id    # Recreate container with new image
```

---

## 7. Docker Socket Integration

The backend communicates with Docker via the mounted socket. Use `dockerode` (Node.js Docker client library).

**Required operations:**
- `container.inspect()` — status, health, config
- `container.stats()` — CPU/memory streaming
- `container.restart()` — restart after config change
- `container.logs()` — fetch and stream logs
- `container.remove()` — for disabling optional modules
- `image.pull()` — for enabling modules and updates
- `docker.listContainers()` — enumerate the Jarvis stack

**Filtering:** Only manage containers with a specific label (e.g., `com.jarvis.managed=true`) to avoid touching non-Jarvis containers.

**Security considerations:**
- Docker socket is root-level access. The admin container should drop all capabilities except what it needs.
- Never expose the admin UI to the public internet (document this clearly).
- The backend should whitelist operations — no raw Docker API passthrough.

---

## 8. Frontend Design

### Tech stack
- React 19 + TypeScript (already in place)
- Vite (already in place)
- Tailwind CSS for styling
- React Router for navigation
- TanStack Query for API state management
- Lucide icons

### Layout
```
┌─────────────────────────────────────────────┐
│  🤖 Jarvis Admin          [status] [user]   │
├──────────┬──────────────────────────────────┤
│          │                                   │
│ Dashboard│    Main content area              │
│ Services │                                   │
│ Modules  │                                   │
│ Logs     │                                   │
│ Updates  │                                   │
│ Settings │                                   │
│          │                                   │
└──────────┴──────────────────────────────────┘
```

### Design principles
- Dark theme by default (matches the "Jarvis" aesthetic)
- No unnecessary animation — this is infrastructure UI, not a consumer app
- Mobile-responsive (users will check status from their phone on the same network)
- Instant feedback — optimistic UI updates, loading skeletons, toast notifications
- Error states are first-class citizens, not afterthoughts

---

## 9. Auth

Simple single-user auth. No OAuth, no user management.

- Password set during first-run wizard
- Stored as bcrypt hash in `admin.json`
- Login returns a JWT stored in httpOnly cookie
- Session timeout: 24 hours (configurable)
- Rate limiting on login endpoint (5 attempts / minute)
- Optional: disable auth entirely for trusted local networks (explicit opt-in setting)

---

## 10. Implementation Phases

### Phase 1: Foundation (MVP for April demo)
- [ ] Backend API server (Express/Fastify) with Docker socket integration
- [ ] Service registry schema and parser
- [ ] Config read/write (env files)
- [ ] Service status endpoint (running/stopped)
- [ ] Frontend: Dashboard with service health cards
- [ ] Frontend: Per-service config editor (schema-driven forms)
- [ ] Frontend: Module enable/disable toggles
- [ ] Basic auth (password gate)
- [ ] Dockerfile for the admin service
- [ ] Integration into the main Jarvis `docker-compose.yml`

### Phase 2: Polish
- [ ] First-run setup wizard
- [ ] Hardware auto-detection
- [ ] Home Assistant auto-discovery
- [ ] Log viewer with streaming
- [ ] Service restart with status feedback
- [ ] Resource usage monitoring (CPU/mem per service)
- [ ] Mobile-responsive layout

### Phase 3: Operations
- [ ] Update checking and one-click updates
- [ ] Config backup/restore (export/import JSON)
- [ ] GPU monitoring dashboard
- [ ] Notification system (service crashed, update available)
- [ ] Changelog viewer

### Phase 4: Ecosystem
- [ ] Portainer / CasaOS / Umbrel template generation
- [ ] CLI wrapper (`jarvis up`, `jarvis config`) that shares config with the admin UI
- [ ] Plugin/command marketplace (browse and install community Jarvis commands)
- [ ] Telemetry opt-in (anonymous usage stats for prioritizing development)

---

## 11. Open Questions

1. **Backend runtime:** Express vs Fastify vs Hono? Fastify is faster and has a good schema validation story, which aligns with the config schema approach.

2. **Docker Compose control:** Should the backend call `docker compose` CLI commands (simpler, requires compose binary in container) or use the Docker API directly (more control, more code)? Recommendation: Docker API via `dockerode` for container operations, but shell out to `docker compose` for profile management since the API doesn't natively understand profiles.

3. **Config file format:** `.env` per service vs single YAML vs JSON config? `.env` is the most Docker-native and what users expect. Keep it.

4. **Native macOS services:** How does the admin handle non-containerized services (Shortcuts integration, Apple Vision)? Options: ignore them (simplest), show them as read-only status cards, or build a lightweight agent that runs natively and reports back to the admin.

5. **Multi-host:** If Jarvis Pi Zero endpoints are on different machines, can the admin manage them? Punt this to Phase 4+ — for now, assume single-host deployment.

---

## 12. Success Criteria

- A new user can go from `docker compose up` to a working Jarvis instance using only the browser UI — no terminal commands after the initial compose up.
- Adding a new service to the Jarvis ecosystem requires only adding an entry to `service-registry.json` and a Compose service definition — zero frontend code changes.
- The admin UI itself adds less than 100MB to the total stack footprint and less than 50MB RAM at runtime.
