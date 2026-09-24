import type { TranscriptSession, Turn } from './types';

export function updateTurn(turns: Turn[], update: Turn): Turn[] {
  const next = turns.filter((turn) => turn.id !== update.replaces_id);
  if (update.final && !update.source.trim() && !update.translation.trim()) {
    return next.filter((turn) => turn.id !== update.id);
  }
  const existing = next.findIndex((turn) => turn.id === update.id);
  if (existing < 0) next.push(update);
  else next[existing] = update;
  return next.sort((a, b) => (a.audio_start_ms ?? Infinity) - (b.audio_start_ms ?? Infinity));
}

export function speakerName(id: Turn['speaker_id']): string {
  return id === null ? 'Speaker pending' : `Speaker ${id}`;
}

export function transcriptText(sessions: TranscriptSession[]): string {
  return sessions
    .map((session, index) =>
      [
        `Session ${index + 1} · ${new Date(session.started).toLocaleString()} · ${session.languageName}`,
        session.ended ? `Ended: ${session.reason ?? 'stopped'}` : 'In progress',
        ...session.turns
          .filter((turn) => turn.source || turn.translation)
          .map((turn) =>
            [
              `${speakerName(turn.speaker_id)}${turn.final ? '' : ' [provisional / incomplete]'}`,
              `Original: ${turn.source || '—'}`,
              `${session.languageName}: ${turn.translation || '—'}`,
            ].join('\n'),
          ),
      ].join('\n\n'),
    )
    .join('\n\n────────────────────────\n\n');
}
