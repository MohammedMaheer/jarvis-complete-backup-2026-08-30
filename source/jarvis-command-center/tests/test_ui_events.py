import asyncio

import pytest

from app.core.ui_events import JarvisUiEvent, UiEventBroker, sse_frame


def test_event_wire_shape_is_redacted_and_stable():
    event = JarvisUiEvent(
        activity="executing",
        phase="progress",
        source="tool",
        label="Running approved local action",
        conversation_id="conversation-1",
        tool_name="open_app",
        metadata={"progress": 50},
    )
    payload = event.public_payload()
    assert payload["schemaVersion"] == 1
    assert payload["conversationId"] == "conversation-1"
    assert payload["toolName"] == "open_app"
    assert "prompt" not in payload
    assert sse_frame(event).startswith(f"id: {event.id}\nevent: jarvis\ndata: ")


@pytest.mark.asyncio
async def test_broker_fanout_is_bounded_and_unsubscribes():
    broker = UiEventBroker(queue_size=8)
    subscriber = broker.subscribe()
    first = asyncio.create_task(subscriber.__anext__())
    await broker.publish(JarvisUiEvent(activity="thinking", phase="start", source="llm", label="Thinking"))
    event = await asyncio.wait_for(first, timeout=1)
    assert event is not None
    await subscriber.aclose()
    await broker.publish(JarvisUiEvent(activity="complete", phase="complete", source="system", label="Done"))


@pytest.mark.asyncio
async def test_broker_replays_events_after_last_event_id():
    broker = UiEventBroker(queue_size=8)
    first = JarvisUiEvent(activity="thinking", phase="start", source="llm", label="Thinking")
    second = JarvisUiEvent(activity="complete", phase="complete", source="system", label="Done")
    await broker.publish(first)
    await broker.publish(second)

    subscriber = broker.subscribe(first.id)
    replayed = await asyncio.wait_for(subscriber.__anext__(), timeout=1)
    assert replayed is second
    await subscriber.aclose()
