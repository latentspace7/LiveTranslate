from functools import cached_property
from pathlib import Path
from typing import Self
from urllib.parse import urlsplit

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MODEL = "qwen3.8-livetranslate-flash-realtime"
SESSION_SECONDS = 240
COOKIE_NAME = "qwen_session"
COOKIE_SECONDS = 8 * 60 * 60


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=Path(__file__).with_name(".env"), extra="ignore")

    dashscope_api_key: SecretStr = SecretStr("")
    dashscope_realtime_url: str = (
        "wss://ws-88iqbhz1c7znqifw.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime"
    )
    auth_password_hash: SecretStr = SecretStr("")
    auth_secret: SecretStr = SecretStr("")
    app_origins: str = "http://localhost:5175"
    cookie_secure: bool = True
    vercel: str = ""

    @cached_property
    def origins(self) -> set[str]:
        return {
            origin.strip().rstrip("/") for origin in self.app_origins.split(",") if origin.strip()
        }

    @property
    def auth_configured(self) -> bool:
        return (
            self.auth_password_hash.get_secret_value().startswith("$argon2id$")
            and len(self.auth_secret.get_secret_value()) >= 32
        )

    @property
    def provider_url(self) -> str:
        return f"{self.dashscope_realtime_url}?model={MODEL}"

    @model_validator(mode="after")
    def validate_deployment(self) -> Self:
        endpoint = urlsplit(self.dashscope_realtime_url)
        if endpoint.scheme != "wss" or not endpoint.hostname or endpoint.query or endpoint.fragment:
            raise ValueError("DASHSCOPE_REALTIME_URL must be a wss URL without query parameters")
        if not self.origins:
            raise ValueError("APP_ORIGINS must contain an explicit origin")
        for origin in self.origins:
            parsed = urlsplit(origin)
            local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
            if (
                not parsed.hostname
                or parsed.path
                or parsed.query
                or parsed.fragment
                or parsed.username
                or "*" in origin
                or (parsed.scheme != "https" and not (local and parsed.scheme == "http"))
            ):
                raise ValueError(
                    "APP_ORIGINS requires exact HTTPS origins, or localhost for development"
                )
            if not self.cookie_secure and not local:
                raise ValueError("COOKIE_SECURE=false is restricted to localhost development")
        if self.vercel and (not self.cookie_secure or not self.auth_configured):
            raise ValueError("Vercel requires secure cookies and configured authentication secrets")
        if self.vercel and any(not origin.startswith("https://") for origin in self.origins):
            raise ValueError("Vercel requires HTTPS application origins")
        return self
