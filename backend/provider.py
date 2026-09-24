from pydantic import BaseModel, ConfigDict, Field, JsonValue


class ProviderModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="ignore", hide_input_in_errors=True)


class Content(ProviderModel):
    text: str | None = None
    transcript: str | None = None


class Item(ProviderModel):
    id: str = ""
    role: str = ""
    content: list[Content] = Field(default_factory=list)


class ProviderResponse(ProviderModel):
    status: str = ""
    output: list[Item] = Field(default_factory=list)
    usage: dict[str, JsonValue] = Field(default_factory=dict)


class AudioFormat(ProviderModel):
    type: str = "pcm"
    sample_rate: int | None = None


class AudioDirection(ProviderModel):
    format: AudioFormat = Field(default_factory=AudioFormat)


class Audio(ProviderModel):
    input: AudioDirection = Field(default_factory=AudioDirection)
    output: AudioDirection = Field(default_factory=AudioDirection)


class ProviderSession(ProviderModel):
    audio: Audio = Field(default_factory=Audio)


class ProviderEvent(ProviderModel):
    type: str = Field(min_length=1)
    item_id: str | None = None
    previous_item_id: str | None = None
    speaker_id: int | str | None = None
    audio_start_ms: int | None = Field(default=None, ge=0)
    language: str | None = None
    delta: str = ""
    text: str = ""
    transcript: str = ""
    item: Item = Field(default_factory=Item)
    response: ProviderResponse = Field(default_factory=ProviderResponse)
    session: ProviderSession = Field(default_factory=ProviderSession)
