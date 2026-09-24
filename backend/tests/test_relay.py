import asyncio
import base64
import json
from contextlib import asynccontextmanager
from dataclasses import replace

import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from relay import Limits, Relay, RelayError


class Browser:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.outgoing = asyncio.Queue()
        self.closed = False

    async def receive(self):
        return await self.incoming.get()

    async def send_json(self, event):
        await self.outgoing.put(event)

    async def send_bytes(self, audio):
        await self.outgoing.put(audio)

    async def close(self, code):
        self.closed = True

    async def send(self, value):
        await self.incoming.put(
            {
                "type": "websocket.receive",
                **({"bytes": value} if isinstance(value, bytes) else {"text": json.dumps(value)}),
            }
        )

    async def until(self, kind):
        events = []
        async with asyncio.timeout(2):
            while True:
                event = await self.outgoing.get()
                events.append(event)
                if isinstance(event, dict) and event["type"] == kind:
                    return events


@asynccontextmanager
async def simulated_provider(handler):
    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]

        async def connector(url, **kwargs):
            return await connect(f"ws://127.0.0.1:{port}", **kwargs)

        yield connector


async def start_relay(settings, connector, *, mode="voice", language="th", limits=None):
    browser = Browser()
    await browser.send({"type": "start", "language": language, "mode": mode})
    relay = Relay(browser, settings, limits or Limits(capture=1), connector)
    running = asyncio.create_task(relay.run())
    return browser, running


@pytest.mark.parametrize("mode,language", [("voice", "th"), ("text", "yue")])
async def test_relay_waits_for_ready_and_flushes_final_utterance(settings, mode, language):
    received = []
    pcm = b"\x01\x00" * 1600

    async def provider(ws):
        assert ws.request.headers["authorization"] == "Bearer test-key-never-sent-to-qwen"
        config = json.loads(await ws.recv())
        assert config["session"]["output_modalities"] == (
            ["text", "audio"] if mode == "voice" else ["text"]
        )
        assert config["session"]["audio"]["input"]["turn_detection"]["type"] == "speaker_detection"
        assert config["session"]["translation"]["language"] == language
        await ws.send(json.dumps({"type": "session.updated"}))
        while True:
            control = json.loads(await ws.recv())
            received.append(control)
            if control["type"] == "session.finish":
                break
        for event in [
            {"type": "input_audio_buffer.speech_started", "item_id": "source", "speaker_id": 0},
            {
                "type": "conversation.item.created",
                "previous_item_id": "source",
                "item": {"id": "translation", "role": "assistant"},
            },
            {
                "type": "conversation.item.input_audio_transcription.completed",
                "item_id": "source",
                "transcript": "Final words",
            },
            {
                "type": "response.audio_transcript.done"
                if mode == "voice"
                else "response.text.done",
                "item_id": "translation",
                "transcript": "คำสุดท้าย",
                "text": "最後的話",
            },
            {"type": "response.audio.delta", "delta": base64.b64encode(pcm).decode()},
            {"type": "session.finished"},
        ]:
            await ws.send(json.dumps(event))
        await ws.wait_closed()

    async with simulated_provider(provider) as connector:
        browser, running = await start_relay(settings, connector, mode=mode, language=language)
        await browser.until("ready")
        await browser.send(pcm)
        await browser.send(b"\x02\x00" * 127)
        await browser.send({"type": "stop"})
        output = await browser.until("ended")
        await running
    assert [item["type"] for item in received] == [
        "input_audio_buffer.append",
        "input_audio_buffer.append",
        "session.finish",
    ]
    assert base64.b64decode(received[1]["audio"]) == b"\x02\x00" * 127
    final = [item for item in output if isinstance(item, dict) and item["type"] == "turn.update"][
        -1
    ]
    assert final["final"] and final["speaker_id"] == 0 and final["source"] == "Final words"
    assert (pcm in output) == (mode == "voice")
    assert browser.closed


async def test_expiry_allows_final_flush_then_finishes(settings):
    received = []

    async def provider(ws):
        await ws.recv()
        await ws.send(json.dumps({"type": "session.updated"}))
        async for raw in ws:
            control = json.loads(raw)
            received.append(control["type"])
            if control["type"] == "session.finish":
                await ws.send(json.dumps({"type": "session.finished"}))

    async with simulated_provider(provider) as connector:
        browser, running = await start_relay(
            settings, connector, limits=Limits(capture=0.04, flush=0.04)
        )
        await browser.until("ready")
        await browser.until("stopping")
        await browser.send(b"\x00\x00" * 50)
        output = await browser.until("ended")
        await running
    assert received == ["input_audio_buffer.append", "session.finish"]
    assert output[-1]["reason"] == "expired"


@pytest.mark.parametrize(
    "scenario,code",
    [
        ("initialization", "initialization_timeout"),
        ("finish", "finish_timeout"),
        ("rejected", "provider_rejected"),
        ("disconnected", "provider_disconnected"),
    ],
)
async def test_provider_failures_are_bounded_and_sanitized(settings, scenario, code, caplog):
    async def provider(ws):
        await ws.recv()
        if scenario == "initialization":
            await ws.wait_closed()
            return
        if scenario == "rejected":
            await ws.send(
                json.dumps({"type": "error", "error": {"message": "PRIVATE TRANSCRIPT OR KEY"}})
            )
        else:
            await ws.send(json.dumps({"type": "session.updated"}))
        if scenario == "disconnected":
            await ws.close()
        else:
            await ws.wait_closed()

    async with simulated_provider(provider) as connector:
        limits = Limits(initialize=0.05, capture=0.05, flush=0.01, drain=0.05)
        browser, running = await start_relay(settings, connector, limits=limits)
        output = await browser.until("ended")
        await running
    assert (
        next(item for item in output if isinstance(item, dict) and item["type"] == "error")["code"]
        == code
    )
    assert "PRIVATE" not in json.dumps(output) + caplog.text
    assert browser.closed


async def test_audio_before_initialization_is_rejected(settings):
    async def provider(ws):
        await ws.wait_closed()

    async with simulated_provider(provider) as connector:
        browser, running = await start_relay(settings, connector)
        await browser.send(b"\x00\x00" * 1600)
        events = await browser.until("ended")
        await running
    assert events[0]["code"] == "not_ready"


async def test_browser_disconnect_closes_provider_even_during_initialization(settings):
    provider_closed = asyncio.Event()

    async def provider(ws):
        try:
            await ws.recv()
            await ws.wait_closed()
        except ConnectionClosed:
            pass
        provider_closed.set()

    async with simulated_provider(provider) as connector:
        browser, running = await start_relay(settings, connector)
        await asyncio.sleep(0.03)
        await browser.incoming.put({"type": "websocket.disconnect", "code": 1001})
        await asyncio.wait_for(running, 0.5)
        await asyncio.wait_for(provider_closed.wait(), 0.5)


async def test_text_only_language_rejects_voice_without_provider_call(settings):
    async def connector(*args, **kwargs):
        raise AssertionError("Provider must not be called")

    browser, running = await start_relay(settings, connector, language="yue")
    events = await browser.until("ended")
    await running
    assert events[0]["code"] == "unsupported_voice"


async def test_overall_deadline_is_below_hobby_limit(settings):
    assert Limits().overall + 5 < 300

    async def provider(ws):
        await ws.recv()
        await ws.send(json.dumps({"type": "session.updated"}))
        await ws.wait_closed()

    async with simulated_provider(provider) as connector:
        browser, running = await start_relay(
            settings, connector, limits=replace(Limits(), overall=0.1)
        )
        events = await browser.until("ended")
        await running
    assert next(event for event in events if event["type"] == "error")["code"] == "session_timeout"


@pytest.mark.parametrize(
    "payload,code",
    [
        (b"\x00", "invalid_audio"),
        (b"\x00" * 3202, "invalid_audio"),
        ({"type": "stop", "audio": "not-binary"}, "invalid_control"),
        (["stop"], "invalid_control"),
    ],
)
async def test_invalid_audio_and_controls_are_rejected(settings, payload, code):
    browser = Browser()
    relay = Relay(browser, settings)
    await browser.send(payload)
    with pytest.raises(RelayError) as error:
        await relay.receive_browser()
    assert error.value.code == code


async def test_slow_browser_and_provider_sends_are_bounded(settings):
    async def slow_send(*args):
        await asyncio.sleep(10)

    browser = Browser()
    browser.send_json = slow_send
    relay = Relay(browser, settings, Limits(send=0.01))
    with pytest.raises(RelayError) as error:
        await relay.send_browser({"type": "ready"})
    assert error.value.code == "slow_connection"
    relay.upstream = type("SlowProvider", (), {"send": slow_send})()
    with pytest.raises(RelayError) as error:
        await relay.send_provider({"type": "session.finish"})
    assert error.value.code == "slow_provider"
