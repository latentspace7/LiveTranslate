import asyncio
import json

from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from relay import RelayError, StartControl, parse_provider, provider_error, session_update
from settings import Settings


async def main() -> None:
    settings = Settings()
    if not settings.dashscope_api_key.get_secret_value():
        raise SystemExit("Set DASHSCOPE_API_KEY in backend/.env first.")
    async with asyncio.timeout(30):
        async with connect(
            settings.provider_url,
            additional_headers={
                "Authorization": f"Bearer {settings.dashscope_api_key.get_secret_value()}"
            },
            max_size=262_144,
            close_timeout=1,
        ) as websocket:
            await websocket.send(
                json.dumps(session_update(StartControl(type="start", language="en", mode="text")))
            )
            async with asyncio.timeout(15):
                while True:
                    event = parse_provider(await websocket.recv())
                    provider_error(event)
                    if event.type == "session.updated":
                        print("Singapore connection and 3.8 session configuration accepted.")
                        break
            await websocket.send(json.dumps({"type": "session.finish"}))
            async with asyncio.timeout(15):
                while True:
                    event = parse_provider(await websocket.recv())
                    provider_error(event)
                    if event.type == "session.finished":
                        print("Graceful session finish accepted. No microphone audio was sent.")
                        return


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (RelayError, WebSocketException, OSError, TimeoutError, ValueError) as error:
        raise SystemExit(
            f"Provider check failed ({type(error).__name__}). Verify workspace access, key, and quota."
        ) from None
