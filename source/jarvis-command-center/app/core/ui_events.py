"""Transient, redacted lifecycle events for the local JARVIS command deck.

The browser never receives broker credentials, prompts, tool arguments, or
audio.  This in-process broadcaster is deliberately bounded and ephemeral:
missing a visual event must never affect command execution.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from typing import AsyncIterator, Literal
from uuid import uuid4


Activity = Literal[
    "idle",
    "listening",
    "transcribing",
    "thinking",
    "memory",
    "executing",
    "speaking",
    "complete",
    "warning",
    "error",
    "offline",
]
Phase = Literal["start", "progress", "complete", "error"]
Source = Literal["system", "mic", "stt", "memory", "llm", "tool", "tts"]


@dataclass(slots=True)
class JarvisUiEvent:
    activity: Activity
    phase: Phase
    source: Source
    label: str
    conversation_id: str | None = None
    tool_name: str | None = None
    progress: float | None = None
    latency_ms: int | None = None
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)
    schema_version: int = 1
    id: str = field(default_factory=lambda: uuid4().hex)
    timestamp: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))

    def public_payload(self) -> dict[str, object]:
        """Return the stable wire shape using camelCase only at the edge."""
        payload = asdict(self)
        return {
            "schemaVersion": payload["schema_version"],
            "id": payload["id"],
            "timestamp": payload["timestamp"],
            "activity": payload["activity"],
            "phase": payload["phase"],
            "source": payload["source"],
            "label": payload["label"],
            **({"conversationId": payload["conversation_id"]} if payload["conversation_id"] else {}),
            **({"toolName": payload["tool_name"]} if payload["tool_name"] else {}),
            **({"progress": payload["progress"]} if payload["progress"] is not None else {}),
            **({"latencyMs": payload["latency_ms"]} if payload["latency_ms"] is not None else {}),
            **({"metadata": payload["metadata"]} if payload["metadata"] else {}),
        }


class UiEventBroker:
    """Fan-out broker with bounded queues and no durable state."""

    def __init__(self, queue_size: int = 64, replay_size: int = 256) -> None:
        self._queue_size = max(8, queue_size)
        self._recent: deque[JarvisUiEvent] = deque(maxlen=max(self._queue_size, replay_size))
        self._subscribers: set[asyncio.Queue[JarvisUiEvent | None]] = set()
        self._lock = asyncio.Lock()

    async def publish(self, event: JarvisUiEvent) -> None:
        async with self._lock:
            self._recent.append(event)
            subscribers = tuple(self._subscribers)
        for queue in subscribers:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # Drop the oldest visual-only event to keep the latest state
                # flowing. Never block or impact the command pipeline.
                try:
                    queue.get_nowait()
                    queue.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    async def subscribe(self, last_event_id: str | None = None) -> AsyncIterator[JarvisUiEvent | None]:
        queue: asyncio.Queue[JarvisUiEvent | None] = asyncio.Queue(self._queue_size)
        async with self._lock:
            replay: list[JarvisUiEvent] = []
            if last_event_id:
                recent = list(self._recent)
                for index, event in enumerate(recent):
                    if event.id == last_event_id:
                        replay = recent[index + 1:]
                        break
            self._subscribers.add(queue)
            for event in replay[-self._queue_size:]:
                queue.put_nowait(event)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20.0)
                except asyncio.TimeoutError:
                    # ``None`` is rendered as an SSE comment by the route;
                    # comments keep proxies from closing an idle dashboard.
                    yield None
                    continue
                if event is None:
                    return
                yield event
        finally:
            async with self._lock:
                self._subscribers.discard(queue)

    async def close(self) -> None:
        async with self._lock:
            subscribers = tuple(self._subscribers)
            self._subscribers.clear()
        for queue in subscribers:
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:
                pass


ui_event_broker = UiEventBroker()


async def publish_ui_event(
    activity: Activity,
    phase: Phase,
    source: Source,
    label: str,
    *,
    conversation_id: str | None = None,
    tool_name: str | None = None,
    progress: float | None = None,
    latency_ms: int | None = None,
    metadata: dict[str, str | int | float | bool] | None = None,
) -> None:
    await ui_event_broker.publish(
        JarvisUiEvent(
            activity=activity,
            phase=phase,
            source=source,
            label=label,
            conversation_id=conversation_id,
            tool_name=tool_name,
            progress=progress,
            latency_ms=latency_ms,
            metadata=metadata or {},
        )
    )


def sse_frame(event: JarvisUiEvent) -> str:
    payload = json.dumps(event.public_payload(), separators=(",", ":"))
    return f"id: {event.id}\nevent: jarvis\ndata: {payload}\n\n"
