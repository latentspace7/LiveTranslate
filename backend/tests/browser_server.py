import asyncio
import base64
import json
import math
import os
import struct

from argon2 import PasswordHasher

from main import create_app
from relay import Limits, Relay
from settings import Settings


class SimulatedQwen:
    def __init__(self):
        self.events = asyncio.Queue()
        self.audio_chunks = 0
        self.audio_bytes = 0
        self.mode = "voice"
        self.language = "en"

    async def send(self, raw):
        event = json.loads(raw)
        if event["type"] == "session.update":
            self.language = event["session"]["translation"]["language"]
            self.mode = "voice" if "audio" in event["session"]["output_modalities"] else "text"
            await self.events.put({"type": "session.updated"})
        if event["type"] == "input_audio_buffer.append":
            audio = base64.b64decode(event["audio"])
            assert len(audio) <= 3200 and len(audio) % 2 == 0
            self.audio_bytes += len(audio)
            self.audio_chunks += 1
            if self.audio_chunks == 2:
                await self.utterance("one", 0, "Hello, how are you?", "สวัสดี คุณสบายดีไหม", False)
            if self.audio_chunks == 4:
                await self.utterance("two", 1, "I am well, thank you.", "我很好，谢谢。", True)
        if event["type"] == "session.finish":
            await self.utterance("one", 0, "Hello, how are you?", "สวัสดี คุณสบายดีไหม", True)
            await self.events.put({"type": "session.finished"})

    async def utterance(self, identity, speaker, original, translated, final):
        if self.language == "en":
            original, translated = translated, original
        await self.events.put(
            {
                "type": "input_audio_buffer.speech_started",
                "item_id": identity,
                "speaker_id": speaker,
                "audio_start_ms": 0 if speaker == 0 else 2000,
            }
        )
        await self.events.put(
            {
                "type": "conversation.item.created",
                "previous_item_id": identity,
                "item": {"id": f"translation-{identity}", "role": "assistant"},
            }
        )
        await self.events.put(
            {
                "type": "conversation.item.input_audio_transcription.completed",
                "item_id": identity,
                "transcript": original,
            }
        )
        kind = "response.audio_transcript" if self.mode == "voice" else "response.text"
        await self.events.put(
            {
                "type": kind + (".done" if final else ".delta"),
                "item_id": f"translation-{identity}",
                "delta": translated[:3],
                "text": translated,
                "transcript": translated,
            }
        )
        if self.mode == "voice" and final:
            pcm = b"".join(
                struct.pack("<h", int(1000 * math.sin(2 * math.pi * 440 * i / 24000)))
                for i in range(2400)
            )
            await self.events.put(
                {"type": "response.audio.delta", "delta": base64.b64encode(pcm).decode()}
            )

    async def recv(self):
        return json.dumps(await self.events.get())

    async def close(self):
        pass


async def connector(*args, **kwargs):
    return SimulatedQwen()


def relay(websocket, settings):
    return Relay(
        websocket,
        settings,
        Limits(capture=int(os.environ.get("SIMULATED_CAPTURE_SECONDS", "3"))),
        connector,
    )


app = create_app(
    Settings(
        _env_file=None,
        auth_password_hash=PasswordHasher().hash("browser-test-password"),
        auth_secret="local-browser-test-signing-secret-only",
        dashscope_api_key="local-simulation-only",
        app_origins="http://127.0.0.1:5174",
        cookie_secure=False,
    ),
    relay,
)
