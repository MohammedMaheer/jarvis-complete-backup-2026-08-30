# 🎙️ Jarvis Local Voice Assistant

Jarvis is an extensible, privacy-first, local voice assistant that runs entirely on your own hardware.

## Neural desktop app

The primary experience is now an Electron desktop shell with a frameless holographic interface, local voice/text turns, and an allowlisted Windows action bridge.

- Launch: `C:\Users\USER\Desktop\Jarvis Assistant.lnk`
- Summon or hide while running: `Ctrl+Space`
- Development shell: run `npm run desktop` from `source\jarvis-admin`
- Portable build: run `npm run desktop:pack` from `source\jarvis-admin`

The shell intentionally controls only named safe actions. It never feeds local-model output directly into PowerShell.

---

## 🚀 Quick Management Scripts (PowerShell)

You can manage the Jarvis stack directly from this directory:

- **Start Jarvis:**
  ```powershell
  .\start-jarvis.ps1
  ```
- **Stop Jarvis:**
  ```powershell
  .\stop-jarvis.ps1
  ```
- **Check Health & Status:**
  ```powershell
  .\status-jarvis.ps1
  ```

---

## 🌐 Web Admin Dashboard

- **URL:** [http://localhost:7711](http://localhost:7711)
- The admin dashboard allows you to:
  1. Complete initial administrator registration.
  2. Configure and switch LLM backends (Local GGUF via llama.cpp / vLLM, or Remote Cloud APIs such as OpenAI, Claude, Ollama).
  3. Manage household members and voice recognition profiles.
  4. Install packages from the community store (The Pantry).
  5. Monitor system logs and service telemetry in real time.

---

## 🔌 Running Microservices & Ports

| Service | Port | Health Endpoint | Description |
| :--- | :--- | :--- | :--- |
| **Admin Gateway** | `7711` | `http://localhost:7711` | React + Fastify Admin UI |
| **Config Service** | `7700` | `http://localhost:7700/health` | Central discovery & registration |
| **Auth & Accounts** | `7701` | `http://localhost:7701/health` | Multi-household JWT authentication |
| **Command Center** | `7703` | `http://localhost:7703/health` | Primary voice turn & tool orchestrator |
| **Whisper STT** | `7706` | `http://localhost:7706/health` | Local speech recognition & speaker ID |
| **TTS Engine** | `7707` | `http://localhost:7707/health` | High-quality Kokoro / Piper speech synthesis |
| **Settings Server** | `7708` | `http://localhost:7708/health` | Runtime configuration aggregator |
| **Notifications** | `7712` | `http://localhost:7712/health` | Push alerts & inbox notifications |
| **Logs Aggregator** | `7702` | `http://localhost:7702/health` | Centralized Loki log handler |
| **Grafana** | `3001` | `http://localhost:3001` | Telemetry & service dashboard |
| **PostgreSQL** | `5435` | `localhost:5435` | Relational database (`pgvector`) |
| **Redis** | `6381` | `localhost:6381` | Background task queue & caching |
| **Mosquitto** | `1884` | `localhost:1884` | MQTT message bus |
| **Loki** | `3100` | `localhost:3100` | Log indexing backend |

---

## 📂 Directory Layout

```
Desktop/jarvis/
├── bin/                 # Jarvis admin binary & web frontend assets
├── compose/             # docker-compose.yml, .env credentials, db init scripts
├── admin.json           # Service routing & upstream configuration
├── start-jarvis.ps1     # One-click start script
├── stop-jarvis.ps1      # Clean shutdown script
├── status-jarvis.ps1    # Live stack health check script
└── README.md            # Architecture & usage guide
```
