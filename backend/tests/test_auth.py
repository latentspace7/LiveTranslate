import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from auth import create_session, valid_session
from languages import LANGUAGES
from main import create_app
from settings import COOKIE_NAME, COOKIE_SECONDS, Settings


def test_authentication_and_secure_cookie(settings):
    with TestClient(create_app(settings), base_url="https://testserver") as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        assert client.get("/api/config").status_code == 401
        assert client.get("/api/auth/session").json() == {"authenticated": False}
        assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 403
        headers = {"origin": "https://testserver"}
        assert (
            client.post("/api/auth/login", json={"password": "wrong"}, headers=headers).status_code
            == 401
        )
        result = client.post(
            "/api/auth/login", json={"password": "test-password-for-local-tests"}, headers=headers
        )
        cookie = result.headers["set-cookie"]
        for flag in ["HttpOnly", "Secure", "SameSite=strict", "Max-Age=28800", "Path=/"]:
            assert flag in cookie
        assert client.get("/api/auth/session").json()["authenticated"] is True
        config = client.get("/api/config")
        assert config.headers["cache-control"] == "no-store"
        assert config.json()["session_seconds"] == 240
        assert config.json()["defaults"] == {"language": "en", "mode": "text"}
        assert len(config.json()["languages"]) == 60
        assert sum(language["audio"] for language in LANGUAGES) == 29
        assert client.post("/api/auth/logout", headers=headers).status_code == 200
        assert client.get("/api/config").status_code == 401


def test_expired_tampered_and_rotated_sessions(settings, monkeypatch):
    token = create_session(settings)
    assert valid_session(token, settings)
    assert not valid_session(token + "tampered", settings)
    real_time = time.time()
    monkeypatch.setattr(time, "time", lambda: real_time + COOKIE_SECONDS + 1)
    assert not valid_session(token, settings)
    monkeypatch.undo()
    rotated = settings.model_copy(
        update={"auth_password_hash": Settings(_env_file=None).auth_password_hash}
    )
    assert not valid_session(token, rotated)


@pytest.mark.parametrize(
    "origin,cookie",
    [
        ("https://evil.example", True),
        (None, True),
        ("https://testserver", False),
    ],
)
def test_websocket_requires_cookie_and_exact_origin(settings, origin, cookie):
    with TestClient(create_app(settings), base_url="https://testserver") as client:
        if cookie:
            client.cookies.set(COOKIE_NAME, create_session(settings))
        with (
            pytest.raises(WebSocketDisconnect) as error,
            client.websocket_connect(
                "/api/translate", headers={"origin": origin} if origin else {}
            ),
        ):
            pass
        assert error.value.code == 1008


def test_production_never_allows_insecure_cookies(settings):
    with pytest.raises(ValueError):
        Settings(_env_file=None, vercel="1", cookie_secure=False)


def test_invalid_password_is_not_reflected(settings):
    with TestClient(create_app(settings), base_url="https://testserver") as client:
        result = client.post(
            "/api/auth/login",
            json={"password": "secret" * 1024},
            headers={"origin": "https://testserver"},
        )
        assert result.status_code == 413
        assert "secret" not in result.text
