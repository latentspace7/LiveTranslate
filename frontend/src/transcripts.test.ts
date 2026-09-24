import { describe, expect, it } from 'vitest';
import { transcriptText, updateTurn } from './transcripts';
import type { TranscriptSession, Turn } from './types';

const turn: Turn = {
  id: 'source',
  speaker_id: null,
  source: 'Hello',
  translation: '',
  source_final: false,
  translation_final: false,
  final: false,
  source_language: 'en',
  audio_start_ms: null,
};

describe('transcript state', () => {
  it('replaces a provisional turn and accepts delayed speaker metadata, including speaker zero', () => {
    let turns = updateTurn([], turn);
    turns = updateTurn(turns, {
      ...turn,
      speaker_id: 0,
      source: 'Hello!',
      translation: 'สวัสดี',
      final: true,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.source).toBe('Hello!');
    expect(turns[0]?.speaker_id).toBe(0);
  });

  it('orders delayed turns by audio time without inventing unknown timestamps', () => {
    const turns = updateTurn([{ ...turn, id: 'later', audio_start_ms: 1000 }], {
      ...turn,
      audio_start_ms: 0,
    });
    expect(turns.map((item) => item.id)).toEqual(['source', 'later']);
  });

  it('exports separate sessions and preserves Unicode and incomplete status', () => {
    const session: TranscriptSession = {
      id: 'one',
      started: '2026-09-23T12:00:00Z',
      language: 'th',
      languageName: 'Thai',
      mode: 'voice',
      ended: true,
      turns: [{ ...turn, translation: 'สวัสดี 你好' }],
    };
    const exported = transcriptText([session, { ...session, id: 'two' }]);
    expect(exported).toContain('Session 1');
    expect(exported).toContain('Session 2');
    expect(exported).toContain('สวัสดี 你好');
    expect(exported).toContain('provisional / incomplete');
    expect(exported).toContain('Speaker pending');
  });
});
