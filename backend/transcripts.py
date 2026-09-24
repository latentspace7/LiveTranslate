from dataclasses import dataclass

from models import TurnEvent
from provider import ProviderEvent


@dataclass
class TextItem:
    text: str = ""
    final: bool = False

    def update(self, text: str, final: bool) -> None:
        if final:
            self.text = text
            self.final = True
        elif not self.final:
            self.text += text
        if len(self.text) > 65_536:
            raise ValueError("Transcript item exceeded limit")


class TranscriptAssembler:
    def __init__(self) -> None:
        self.sources: dict[str, TextItem] = {}
        self.translations: dict[str, TextItem] = {}
        self.links: dict[str, str] = {}
        self.speakers: dict[str, int | str] = {}
        self.languages: dict[str, str] = {}
        self.starts: dict[str, int] = {}

    def turn(self, source_id: str) -> TurnEvent:
        source = self.sources.setdefault(source_id, TextItem())
        translations = [
            self.translations[key]
            for key, value in self.links.items()
            if value == source_id and key in self.translations
        ]
        translated = "".join(item.text for item in translations)
        translation_final = bool(translations) and all(item.final for item in translations)
        return {
            "type": "turn.update",
            "id": source_id,
            "speaker_id": self.speakers.get(source_id),
            "source": source.text,
            "translation": translated,
            "source_final": source.final,
            "translation_final": translation_final,
            "final": source.final and translation_final,
            "source_language": self.languages.get(source_id),
            "audio_start_ms": self.starts.get(source_id),
        }

    def consume(self, event: ProviderEvent | dict[str, object]) -> list[TurnEvent]:
        if not isinstance(event, ProviderEvent):
            event = ProviderEvent.model_validate(event)
        kind = event.type
        item_id = event.item_id
        changed: set[str] = set()
        unlinked: set[str] = set()
        replacements: dict[str, str] = {}
        if kind == "input_audio_buffer.speech_started" and item_id:
            if event.speaker_id is not None:
                self.speakers[item_id] = event.speaker_id
            if isinstance(event.audio_start_ms, int):
                self.starts[item_id] = event.audio_start_ms
            changed.add(item_id)
        elif kind == "conversation.item.created":
            item = event.item
            if item.role == "assistant" and item.id and event.previous_item_id:
                self.links[item.id] = event.previous_item_id
                changed.add(event.previous_item_id)
                replacements[event.previous_item_id] = f"unassociated:{item.id}"
        elif (
            kind
            in {
                "conversation.item.input_audio_transcription.delta",
                "conversation.item.input_audio_transcription.completed",
            }
            and item_id
        ):
            final = kind.endswith("completed")
            self.sources.setdefault(item_id, TextItem()).update(
                event.transcript if final else event.delta, final
            )
            if event.language:
                self.languages[item_id] = event.language
            changed.add(item_id)
        elif (
            kind
            in {
                "response.text.delta",
                "response.audio_transcript.delta",
                "response.text.done",
                "response.audio_transcript.done",
            }
            and item_id
        ):
            final = kind.endswith("done")
            text = (
                event.delta
                if not final
                else (event.text if kind == "response.text.done" else event.transcript)
            )
            self.translations.setdefault(item_id, TextItem()).update(text, final)
            if item_id in self.links:
                changed.add(self.links[item_id])
            else:
                unlinked.add(item_id)
        elif kind == "response.done":
            response = event.response
            for item in response.output:
                if item.role != "assistant" or not item.id:
                    continue
                item_id = item.id
                text = "".join(
                    (part.text if part.text is not None else part.transcript or "")
                    for part in item.content
                )
                translation = self.translations.setdefault(item_id, TextItem())
                if text:
                    translation.update(text, True)
                translation.final = response.status == "completed"
                if item_id in self.links:
                    changed.add(self.links[item_id])
                else:
                    unlinked.add(item_id)
        updates = [self.turn(source_id) for source_id in sorted(changed)]
        for update in updates:
            if update["id"] in replacements:
                update["replaces_id"] = replacements[update["id"]]
        updates.extend(self.unassociated_turn(item_id) for item_id in sorted(unlinked))
        if len(self.sources) + len(self.translations) > 2048:
            raise ValueError("Transcript item count exceeded limit")
        return updates

    def unassociated_turn(self, item_id: str) -> TurnEvent:
        item = self.translations[item_id]
        return {
            "type": "turn.update",
            "id": f"unassociated:{item_id}",
            "speaker_id": None,
            "source": "",
            "translation": item.text,
            "source_final": False,
            "translation_final": item.final,
            "final": False,
            "source_language": None,
            "audio_start_ms": None,
        }

    def unassociated(self) -> list[TurnEvent]:
        return [
            self.unassociated_turn(item_id)
            for item_id in self.translations
            if item_id not in self.links
        ]
