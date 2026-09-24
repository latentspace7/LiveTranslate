import logging
from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from auth import create_session, valid_session, verify_password
from languages import LANGUAGES
from middleware import SecurityHeadersMiddleware
from models import AuthResponse, ConfigResponse, HealthResponse, LanguageResponse, Login
from relay import Relay
from settings import COOKIE_NAME, COOKIE_SECONDS, SESSION_SECONDS, Settings

logging.getLogger("qwen").setLevel(logging.INFO)


def create_app(
    settings: Settings | None = None,
    relay_factory: Callable[[WebSocket, Settings], Relay] = Relay,
) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(SecurityHeadersMiddleware)

    def check_origin(origin: str | None) -> None:
        if origin not in settings.origins:
            raise HTTPException(403, "Origin is not allowed")

    def require_session(request: Request) -> None:
        if not valid_session(request.cookies.get(COOKIE_NAME), settings):
            raise HTTPException(401, "Please sign in")

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({"detail": "Invalid request"}, status_code=422)

    @app.get("/api/health")
    async def health() -> HealthResponse:
        return HealthResponse()

    @app.post("/api/auth/login")
    async def login(body: Login, request: Request, response: Response) -> AuthResponse:
        check_origin(request.headers.get("origin"))
        if not settings.auth_configured:
            raise HTTPException(503, "Server authentication is not configured")
        if not await run_in_threadpool(verify_password, body.password, settings):
            raise HTTPException(401, "Incorrect password")
        response.set_cookie(
            COOKIE_NAME,
            create_session(settings),
            max_age=COOKIE_SECONDS,
            httponly=True,
            secure=settings.cookie_secure,
            samesite="strict",
            path="/",
        )
        return AuthResponse(authenticated=True)

    @app.post("/api/auth/logout")
    async def logout(request: Request, response: Response) -> AuthResponse:
        check_origin(request.headers.get("origin"))
        response.delete_cookie(
            COOKIE_NAME, path="/", secure=settings.cookie_secure, httponly=True, samesite="strict"
        )
        return AuthResponse(authenticated=False)

    @app.get("/api/auth/session")
    async def session(request: Request) -> AuthResponse:
        return AuthResponse(authenticated=valid_session(request.cookies.get(COOKIE_NAME), settings))

    @app.get("/api/config")
    async def config(_: Annotated[None, Depends(require_session)]) -> ConfigResponse:
        return ConfigResponse(
            languages=[LanguageResponse(**language) for language in LANGUAGES],
            session_seconds=SESSION_SECONDS,
        )

    @app.websocket("/api/translate")
    async def translate(websocket: WebSocket) -> None:
        if websocket.headers.get("origin") not in settings.origins or not valid_session(
            websocket.cookies.get(COOKIE_NAME), settings
        ):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        await relay_factory(websocket, settings).run()

    return app


app = create_app()
