import asyncio
import base64
import json
import logging
import struct
import time
import uuid
from collections.abc import Awaitable, Callable, Coroutine, Mapping
from contextlib import suppress
from dataclasses import dataclass
from typing import Literal, TypedDict

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, field_validator
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from languages import TEXT_LANGUAGES, VOICE_LANGUAGES
from provider import ProviderEvent
from settings import SESSION_SECONDS, Settings
from transcripts import TranscriptAssembler

logger = logging.getLogger("qwen.relay")


class StartControl(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["start"]
    language: str
    mode: Literal["text", "voice"]

    @field_validator("language")
    @classmethod
    def supported_language(cls, language: str) -> str:
        if language not in VOICE_LANGUAGES and language not in TEXT_LANGUAGES:
            raise ValueError("Unsupported target language")
        return language


class StopControl(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["stop"]


class BrowserControl(TypedDict, total=False):
    type: Literal["start", "stop"]
    language: str
    mode: Literal["text", "voice"]
    audio: bytes


@dataclass(frozen=True)
class Limits:
    start: float = 10
    initialize: float = 15
    capture: float = SESSION_SECONDS
    flush: float = 1
    drain: float = 15
    overall: float = 285
    send: float = 2


class RelayError(Exception):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(code)


def session_update(start: StartControl) -> dict[str, object]:
    return {
        "type": "session.update",
        "session": {
            "output_modalities": ["text", "audio"] if start.mode == "voice" else ["text"],
            "translation": {"language": start.language},
            "audio": {"input": {"turn_detection": {"type": "speaker_detection"}}},
        },
    }


def parse_provider(raw: str | bytes) -> ProviderEvent:
    try:
        return ProviderEvent.model_validate_json(raw)
    except ValueError as exc:
        raise RelayError(
            "provider_protocol", "The translation service sent an invalid response."
        ) from exc


def provider_error(event: ProviderEvent) -> None:
    if event.type in {"error", "conversation.item.input_audio_transcription.failed"}:
        raise RelayError(
            "provider_rejected",
            "The translation service rejected the session. Check the API key, workspace access, and quota.",
        )
    if event.type == "response.done" and event.response.status == "failed":
        raise RelayError(
            "provider_failed", "The translation service could not complete this utterance."
        )


def log_usage(event: ProviderEvent) -> None:
    if event.type != "response.done":
        return
    usage = event.response.usage
    counts = {
        key: value
        for key, value in usage.items()
        if key in {"total_tokens", "input_tokens", "output_tokens"} and type(value) in {int, float}
    }
    logger.info("provider_usage %s", json.dumps(counts))


class Relay:
    def __init__(
        self,
        websocket: WebSocket,
        settings: Settings,
        limits: Limits | None = None,
        connector: Callable[..., Awaitable[ClientConnection]] = connect,
    ) -> None:
        self.browser = websocket
        self.settings = settings
        self.limits = limits or Limits()
        self.connector = connector
        self.upstream: ClientConnection | None = None
        self.tasks: set[asyncio.Task[object]] = set()
        self.assembler = TranscriptAssembler()
        self.audio_bytes = 0
        self.audio_peak = 0
        self.speech_events = 0
        self.source_updates = 0
        self.translation_updates = 0

    def task[T](self, awaitable: Coroutine[object, object, T]) -> asyncio.Task[T]:
        task = asyncio.create_task(awaitable)
        self.tasks.add(task)
        task.add_done_callback(self.task_finished)
        return task

    def task_finished(self, task: asyncio.Task[object]) -> None:
        self.tasks.discard(task)
        if not task.cancelled():
            task.exception()

    async def send_browser(self, event: Mapping[str, object] | bytes) -> None:
        try:
            async with asyncio.timeout(self.limits.send):
                if isinstance(event, bytes):
                    await self.browser.send_bytes(event)
                else:
                    await self.browser.send_json(event)
        except TimeoutError as exc:
            raise RelayError(
                "slow_connection",
                "The connection is too slow. Start a new session when it improves.",
            ) from exc

    async def send_provider(self, event: dict[str, object]) -> None:
        if self.upstream is None:
            raise RuntimeError("Provider connection is not open")
        payload = {**event, "event_id": f"event_{uuid.uuid4().hex}"}
        try:
            async with asyncio.timeout(self.limits.send):
                await self.upstream.send(json.dumps(payload))
        except TimeoutError as exc:
            raise RelayError(
                "slow_provider", "The translation service is responding too slowly."
            ) from exc

    async def receive_browser(self) -> BrowserControl:
        message = await self.browser.receive()
        if message["type"] == "websocket.disconnect":
            raise WebSocketDisconnect(message.get("code", 1000))
        audio = message.get("bytes")
        if audio is not None:
            if not audio or len(audio) > 3200 or len(audio) % 2:
                raise RelayError(
                    "invalid_audio", "Audio must be 16 kHz mono PCM in chunks of at most 100 ms."
                )
            return {"audio": audio}
        text = message.get("text", "")
        if len(text) > 1024:
            raise RelayError("invalid_control", "Session control exceeded the size limit.")
        try:
            control: object = json.loads(text)
            if not isinstance(control, dict):
                raise TypeError("Expected a control object")
            if control.get("type") == "stop":
                StopControl.model_validate(control)
                return {"type": "stop"}
            start = StartControl.model_validate(control)
            return {"type": "start", "language": start.language, "mode": start.mode}
        except (ValueError, TypeError) as exc:
            raise RelayError("invalid_control", "Invalid session control.") from exc

    async def open_provider(self) -> ClientConnection:
        return await self.connector(
            self.settings.provider_url,
            additional_headers={
                "Authorization": f"Bearer {self.settings.dashscope_api_key.get_secret_value()}"
            },
            open_timeout=self.limits.initialize,
            close_timeout=1,
            max_size=262_144,
            max_queue=8,
            write_limit=32_768,
            ping_interval=20,
            ping_timeout=20,
            compression=None,
        )

    async def initialize(
        self, start: StartControl, client: asyncio.Task[BrowserControl]
    ) -> asyncio.Task[BrowserControl] | None:
        started = time.monotonic()
        opening = self.task(self.open_provider())
        try:
            async with asyncio.timeout(self.limits.initialize):
                done, _ = await asyncio.wait({opening, client}, return_when=asyncio.FIRST_COMPLETED)
                if client in done:
                    control = client.result()
                    if control.get("type") == "stop":
                        return None
                    raise RelayError(
                        "not_ready", "Wait for the session to be ready before sending audio."
                    )
                self.upstream = opening.result()
                await self.send_provider(session_update(start))
                while True:
                    incoming = self.task(self.upstream.recv())
                    done, _ = await asyncio.wait(
                        {incoming, client}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if client in done:
                        control = client.result()
                        if control.get("type") == "stop":
                            return None
                        raise RelayError(
                            "not_ready", "Wait for the session to be ready before sending audio."
                        )
                    event = parse_provider(incoming.result())
                    provider_error(event)
                    if event.type == "session.updated":
                        audio = event.session.audio
                        for direction, rate in ((audio.input, 16000), (audio.output, 24000)):
                            format_ = direction.format
                            if (
                                format_.sample_rate is not None
                                and format_.sample_rate != rate
                                or format_.type != "pcm"
                            ):
                                raise RelayError(
                                    "provider_format",
                                    "The translation service selected an unsupported audio format.",
                                )
                        logger.info(
                            "provider_ready elapsed_ms=%d", (time.monotonic() - started) * 1000
                        )
                        return client
        except TimeoutError as exc:
            raise RelayError(
                "initialization_timeout", "Translation did not become ready within 15 seconds."
            ) from exc
        finally:
            if not opening.done():
                opening.cancel()
                await asyncio.gather(opening, return_exceptions=True)
            elif self.upstream is None and not opening.cancelled() and opening.exception() is None:
                self.upstream = opening.result()

    async def stream(self, client: asyncio.Task[BrowserControl], start: StartControl) -> str:
        if self.upstream is None:
            raise RuntimeError("Provider connection is not open")
        started = time.monotonic()
        capture_end = started + self.limits.capture
        finish_at = None
        drain_end = None
        reason = "stopped"
        total_bytes = 0
        provider = self.task(self.upstream.recv())
        await self.send_browser(
            {
                "type": "ready",
                "session_seconds": self.limits.capture,
                "language": start.language,
                "mode": start.mode,
            }
        )
        logger.info("session_ready")
        while True:
            now = time.monotonic()
            if drain_end is not None and now >= drain_end:
                raise RelayError(
                    "finish_timeout",
                    "The service did not finish in time. The last utterance may be incomplete.",
                )
            if finish_at is None and drain_end is None and now >= capture_end:
                reason = "expired"
                finish_at = now + self.limits.flush
                await self.send_browser({"type": "stopping", "reason": reason})
            if finish_at is not None and now >= finish_at:
                await self.send_provider({"type": "session.finish"})
                finish_at = None
                drain_end = time.monotonic() + self.limits.drain
            deadline = (
                drain_end
                if drain_end is not None
                else (finish_at if finish_at is not None else capture_end)
            )
            done, _ = await asyncio.wait(
                {client, provider},
                timeout=max(0, deadline - time.monotonic()),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if client in done:
                control = client.result()
                client = self.task(self.receive_browser())
                if "audio" in control:
                    if drain_end is not None:
                        raise RelayError(
                            "audio_after_stop", "Audio was sent after the session stopped."
                        )
                    audio = control["audio"]
                    self.audio_bytes += len(audio)
                    self.audio_peak = max(
                        self.audio_peak,
                        max(abs(sample[0]) for sample in struct.iter_unpack("<h", audio)),
                    )
                    total_bytes += len(audio)
                    max_bytes = int(self.limits.capture * 32000) + 3200
                    realtime_bytes = int((time.monotonic() - started + 1) * 32000)
                    if total_bytes > min(max_bytes, realtime_bytes):
                        raise RelayError(
                            "audio_limit",
                            "Audio arrived faster than real time or exceeded the session limit.",
                        )
                    await self.send_provider(
                        {
                            "type": "input_audio_buffer.append",
                            "audio": base64.b64encode(audio).decode(),
                        }
                    )
                elif control == {"type": "stop"}:
                    if drain_end is None:
                        reason = "expired" if time.monotonic() >= capture_end else "stopped"
                        await self.send_provider({"type": "session.finish"})
                        finish_at = None
                        drain_end = time.monotonic() + self.limits.drain
                else:
                    raise RelayError(
                        "invalid_control", "Start a new connection to change session settings."
                    )
            if provider in done:
                event = parse_provider(provider.result())
                provider_error(event)
                log_usage(event)
                if event.type == "input_audio_buffer.speech_started":
                    self.speech_events += 1
                if (
                    event.type == "conversation.item.input_audio_transcription.delta"
                    and event.delta
                ):
                    self.source_updates += 1
                if (
                    event.type in {"response.text.delta", "response.audio_transcript.delta"}
                    and event.delta
                ):
                    self.translation_updates += 1
                for turn in self.assembler.consume(event):
                    await self.send_browser(turn)
                if event.type == "response.audio.delta" and start.mode == "voice":
                    try:
                        audio = base64.b64decode(event.delta, validate=True)
                        if len(audio) % 2:
                            raise ValueError
                    except ValueError as exc:
                        raise RelayError(
                            "provider_audio", "The translation service sent invalid audio."
                        ) from exc
                    if audio:
                        await self.send_browser(audio)
                if event.type == "session.finished":
                    if drain_end is None:
                        raise RelayError(
                            "provider_disconnected",
                            "The translation service ended unexpectedly. Start a new session.",
                        )
                    return reason
                provider = self.task(self.upstream.recv())

    async def run(self) -> None:
        started = time.monotonic()
        reason = "error"
        connected = True
        try:
            async with asyncio.timeout(self.limits.overall):
                try:
                    async with asyncio.timeout(self.limits.start):
                        first = await self.receive_browser()
                    start = StartControl.model_validate(first)
                except (ValueError, TimeoutError) as exc:
                    raise RelayError(
                        "invalid_start", "Send a valid start request within 10 seconds."
                    ) from exc
                if start.mode == "voice" and start.language not in VOICE_LANGUAGES:
                    raise RelayError(
                        "unsupported_voice", "This language supports text output only."
                    )
                if not self.settings.dashscope_api_key.get_secret_value():
                    raise RelayError(
                        "not_configured",
                        "The translation API key has not been configured on the server.",
                    )
                client = self.task(self.receive_browser())
                ready_client = await self.initialize(start, client)
                reason = await self.stream(ready_client, start) if ready_client else "cancelled"
        except WebSocketDisconnect:
            connected = False
            reason = "disconnected"
        except (
            RelayError,
            ConnectionClosed,
            InvalidStatus,
            TimeoutError,
            OSError,
            ValueError,
        ) as exc:
            if isinstance(exc, RelayError):
                error = exc
            elif isinstance(exc, InvalidStatus):
                error = RelayError(
                    "provider_rejected",
                    "The translation service refused the connection. Check the API key and workspace access.",
                )
            elif isinstance(exc, TimeoutError):
                error = RelayError(
                    "session_timeout",
                    "The session reached its connection deadline. Start a new session.",
                )
            else:
                error = RelayError(
                    "provider_disconnected",
                    "The translation connection was interrupted. Your visible transcript is preserved.",
                )
            logger.warning("session_error code=%s", error.code)
            with suppress(Exception):
                await self.send_browser(
                    {"type": "error", "code": error.code, "message": error.message}
                )
        finally:
            pending = list(self.tasks)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            if self.upstream is not None:
                with suppress(Exception):
                    async with asyncio.timeout(2):
                        await self.upstream.close()
            if connected:
                with suppress(Exception):
                    async with asyncio.timeout(3):
                        for turn in self.assembler.unassociated():
                            await self.send_browser(turn)
                        await self.send_browser({"type": "ended", "reason": reason})
                        await self.browser.close(code=1000)
            logger.info(
                "session_ended reason=%s elapsed_ms=%d audio_bytes=%d audio_peak=%d "
                "speech_events=%d source_updates=%d translation_updates=%d",
                reason,
                (time.monotonic() - started) * 1000,
                self.audio_bytes,
                self.audio_peak,
                self.speech_events,
                self.source_updates,
                self.translation_updates,
            )
