from typing import Literal, NotRequired, TypedDict

from pydantic import BaseModel, ConfigDict, Field

type Mode = Literal["text", "voice"]


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    password: str = Field(min_length=1, max_length=1024, repr=False)


class AuthResponse(BaseModel):
    authenticated: bool


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


class Language(TypedDict):
    code: str
    name: str
    audio: bool


class LanguageResponse(BaseModel):
    code: str
    name: str
    audio: bool


class Defaults(BaseModel):
    language: str = "en"
    mode: Mode = "text"


class ConfigResponse(BaseModel):
    languages: list[LanguageResponse]
    session_seconds: int = Field(gt=0, le=240)
    defaults: Defaults = Field(default_factory=Defaults)


class TurnEvent(TypedDict):
    type: Literal["turn.update"]
    id: str
    replaces_id: NotRequired[str]
    speaker_id: int | str | None
    source: str
    translation: str
    source_final: bool
    translation_final: bool
    final: bool
    source_language: str | None
    audio_start_ms: int | None
