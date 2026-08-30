# JARVIS Neural Desktop Architecture

See `AI_STACK.md` for the active local intelligence, retrieval, and orchestration selections.

## Goal

Provide an OS-like local assistant experience on top of Windows without replacing the operating system or granting generated model text unrestricted command execution.

## Runtime

```text
Electron shell
  |-- sandboxed React renderer (localhost:7711)
  |-- isolated preload bridge
  |-- allowlisted native action broker
  |
  +--> Jarvis Admin API --> llama.cpp / Qwen3 8B
                       |--> Whisper STT + speaker encoder
                       +--> local neural TTS
```

The Windows sign-in launcher starts components in bounded dependency order:

1. native CUDA llama.cpp / Qwen;
2. Docker Linux engine;
3. PostgreSQL, Redis, and MQTT;
4. config service;
5. auth service;
6. Command Center;
7. Whisper and TTS;
8. supporting logs, notifications, settings, and observability;
9. admin API and the Electron shell.

Every external process and health probe has a timeout. Startup never pulls images automatically during sign-in. If a fresh Docker backend crash explicitly identifies an inaccessible Unix-socket placeholder, the launcher performs one scoped self-repair against a fixed allowlist of Docker runtime sockets, restarts Docker once, and never touches images, volumes, containers, or user data. The latest machine-readable result is written to `logs/startup-latest.json`, while `logs/startup-latest.log` contains stage output and bounded failure diagnostics. The Electron shell still opens in diagnostic mode if a dependency fails. `Ctrl+Space` hides or summons the shell while it is running.

On Windows, Compose reads the authoritative runtime environment from `%USERPROFILE%\.jarvis\compose\.env`. `JARVIS_HOST_COMPOSE_DIR` replaces the unreliable `HOME` interpolation used by PowerShell 5.1 background jobs. PostgreSQL and Redis publish only on loopback and use this workstation's collision-free host ports (`5435` and `6381`); Grafana uses `3001`. Before Compose starts, the launcher validates these values and reports the name of any other Docker container already publishing one of them.

The Auth service owns the service-to-service clients. Their one-time keys must be persisted as matching `JARVIS_APP_ID_*` / `JARVIS_APP_KEY_*` pairs in the runtime environment; otherwise liveness can remain green while protected Whisper or TTS requests correctly return 401. Startup recreation propagates rotated keys into Config, Auth, Command Center, Whisper, TTS, Logs, Notifications, and Settings. Keys and user credentials are never written to startup logs.

The native CUDA inference process runs at Windows `BelowNormal` priority. This keeps foreground applications responsive under a long prompt while preserving GPU offload, a single parallel inference slot, and the 16,384-token context window.

## Agent-control contract

The renderer can request only typed, schema-checked actions exposed by the preload bridge. The main process validates both the sending origin and the requested target against static allowlists.

Currently supported:

- Open Calculator, Notepad, File Explorer, Windows Terminal, Task Manager, or Windows Settings.
- Open the Jarvis workspace, Desktop, Downloads, or Documents folder.
- Read hostname, CPU thread count, memory, platform, and uptime.
- Lock Windows, control master volume, sleep, restart, or shut down after the required confirmation gate.
- Minimize, maximize, close, hide, or summon the JARVIS window.

Explicitly excluded:

- Arbitrary PowerShell, shell strings, downloaded code, registry edits, file deletion, credential access, or unreviewed model-generated tool calls.

## Reliability and security

- `nodeIntegration: false`, `contextIsolation: true`, renderer sandbox enabled.
- Microphone permission is allowed only for the two loopback Jarvis origins.
- Navigation is confined to the local Jarvis origins; HTTPS links open in the system browser.
- A single-instance lock prevents duplicate assistants.
- Desktop actions return confirmed results; the assistant does not claim success before IPC completion.

## Growth path

Future capabilities should be added as individually named actions with input validation, permissions, audit logging, dry-run previews, and confirmation levels. High-impact actions should never share the same execution tier as read-only status checks.
