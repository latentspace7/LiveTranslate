from transcripts import TranscriptAssembler


def event(kind, item="source-1", **fields):
    return {"type": kind, "item_id": item, **fields}


def test_delayed_metadata_and_two_speakers_do_not_cross_assign():
    assembler = TranscriptAssembler()
    pending = assembler.consume(event("response.text.delta", "translation-1", delta="สวัสดี"))[0]
    assert (pending["translation"], pending["speaker_id"]) == ("สวัสดี", None)
    first = assembler.consume(
        event("conversation.item.input_audio_transcription.delta", delta="Hell")
    )[0]
    assert first["speaker_id"] is None
    assembler.consume(event("conversation.item.input_audio_transcription.delta", delta="o"))
    assembler.consume(
        event("input_audio_buffer.speech_started", "source-2", speaker_id=1, audio_start_ms=2000)
    )
    assembler.consume(event("input_audio_buffer.speech_started", speaker_id=0, audio_start_ms=0))
    linked = assembler.consume(
        {
            "type": "conversation.item.created",
            "previous_item_id": "source-1",
            "item": {"id": "translation-1", "role": "assistant"},
        }
    )[0]
    assert (linked["speaker_id"], linked["source"], linked["translation"]) == (0, "Hello", "สวัสดี")
    assembler.consume(
        event(
            "conversation.item.input_audio_transcription.completed",
            transcript="Hello!",
            language="en",
        )
    )
    final = assembler.consume(event("response.text.done", "translation-1", text="สวัสดี!"))[0]
    assert final["final"] and final["source"] == "Hello!" and final["translation"] == "สวัสดี!"
    assert assembler.turn("source-2")["translation"] == ""
    assert assembler.turn("source-2")["speaker_id"] == 1


def test_audio_transcript_final_replaces_deltas_and_ignores_late_delta():
    assembler = TranscriptAssembler()
    assembler.consume(
        {
            "type": "conversation.item.created",
            "previous_item_id": "s",
            "item": {"role": "assistant", "id": "t"},
        }
    )
    assembler.consume(event("response.audio_transcript.delta", "t", delta="你"))
    assembler.consume(event("response.audio_transcript.delta", "t", delta="好"))
    result = assembler.consume(event("response.audio_transcript.done", "t", transcript="你好。"))[0]
    assert result["translation"] == "你好。"
    assert (
        assembler.consume(event("response.audio_transcript.delta", "t", delta="late"))[0][
            "translation"
        ]
        == "你好。"
    )


def test_unassociated_translation_preserved_without_speaker_guess():
    assembler = TranscriptAssembler()
    assembler.consume(event("response.text.done", "orphan", text="Unpaired translation"))
    orphan = assembler.unassociated()[0]
    assert orphan["speaker_id"] is None and orphan["source"] == "" and not orphan["final"]


def test_incomplete_response_is_not_labeled_final():
    assembler = TranscriptAssembler()
    assembler.consume(
        {
            "type": "conversation.item.created",
            "previous_item_id": "s",
            "item": {"role": "assistant", "id": "t"},
        }
    )
    assembler.consume(
        event("conversation.item.input_audio_transcription.completed", "s", transcript="Hello")
    )
    assembler.consume(event("response.text.done", "t", text="สวัสดี"))
    result = assembler.consume(
        {
            "type": "response.done",
            "response": {
                "status": "incomplete",
                "output": [
                    {"id": "t", "role": "assistant", "content": [{"type": "text", "text": "สวัสดี"}]},
                ],
            },
        }
    )[0]
    assert not result["final"]
