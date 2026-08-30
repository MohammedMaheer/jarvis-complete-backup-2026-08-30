# Jarvis Admin Design System

## Direction

Jarvis uses an operational, calm interface inspired by aerospace HUDs: deep neutral surfaces, cyan intelligence and telemetry accents, and green healthy-state feedback. The visual system supports both light and dark modes and stays usable at compact desktop widths.

## Biometric Gateway

The login experience is voice-first. A live WebGL neural core anchors the screen, while a rotating challenge phrase prevents a static voice recording from being sufficient. Credential login remains available in a collapsed recovery channel. Voice states use semantic motion and color: cyan for ready, rose for listening, amber for processing, and green for verified.

## Agent Traces

Agent work is visible as a node graph instead of an unexplained spinner. Each workflow exposes queued, running, completed, or failed states and displays actual evidence from hardware probes, service health, native IPC, and local model timings. State-changing actions are approval-gated.

## Tokens

- `--color-primary`: intelligence, focus, and primary actions.
- `--color-secondary`: healthy and ready states.
- `--color-tertiary`: infrastructure and telemetry.
- `--color-surface` / `--color-surface-alt`: panel and nested-control surfaces.
- `--color-border`: all structural dividers and control outlines.
- `--shadow-panel` / `--radius-panel`: shared elevated-panel treatment.

## Patterns

- Use `.jarvis-panel` for page-level cards and operational groups.
- Use `.jarvis-orb` only for the assistant identity or live voice affordance.
- Keep status colors semantic; never use green for generic decoration.
- All icon-only actions need an accessible label or `title`.
- Motion must honor `prefers-reduced-motion`.

### Command Reactor

- `JarvisCommandConsole` is the primary assistant surface: reactor visualization, live local-service status, conversation transcript, text command input, microphone capture, speech-output mute, and latency telemetry.
- The reactor communicates state through restrained cyan motion: idle, listening, thinking, speaking, ready, and error. State must also be written as text so color and motion are never the only signal.
- Text and voice are equal inputs. The send button remains keyboard accessible, microphone and mute controls have labels, and microphone capture never starts automatically.
- At narrow widths telemetry stacks beneath the reactor and the composer retains a minimum 44px target size. Long answers scroll inside the transcript instead of expanding the full page.
- The dashboard may display professional personalization, but must not expose private contact details or send content to a cloud LLM.

### Holographic Core

- `HolographicCore` is the cinematic desktop focal point. It uses composited CSS 3D transforms, orbital particles, a projected floor grid, a volumetric beam, latitude/longitude geometry, and the existing semantic reactor states.
- Cyan is operational intelligence, amber is active reasoning, red is listening/emergency, and emerald is verified healthy state. Decorative particles never replace a written status.
- Animations use transform and opacity so they stay GPU-composited beside local inference. Every continuous animation stops under `prefers-reduced-motion`.
- The stage scales down below 520px and removes nonessential edge labels before shrinking the core.

### Native Desktop Chrome

- The Electron title bar is draggable only through `.jarvis-titlebar`; every interactive descendant belongs inside `.jarvis-no-drag`.
- Native window controls are visible only when the isolated preload bridge is present. Browser mode retains the ordinary dashboard without dead controls.
- Desktop capability is explicitly labeled `Native shell`; never imply native control when the UI is running in a browser.

## Layout

- Navigation collapses to an icon rail below the large breakpoint.
- Page content uses responsive padding and a 72rem maximum for primary dashboards.
- Dense management tables remain inside scrollable page content rather than expanding the viewport.
