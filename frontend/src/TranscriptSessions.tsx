import { useEffect, useRef } from 'react';
import { speakerName } from './transcripts';
import type { TranscriptSession } from './types';

export function TranscriptSessions({ sessions }: { sessions: TranscriptSession[] }) {
  const transcriptView = useRef<HTMLDivElement | null>(null);
  const followLatest = useRef(true);

  useEffect(() => {
    if (transcriptView.current && followLatest.current) {
      transcriptView.current.scrollTop = transcriptView.current.scrollHeight;
    }
  }, [sessions]);

  useEffect(() => {
    followLatest.current = true;
    if (sessions.length && window.matchMedia('(max-width: 680px)').matches) {
      transcriptView.current?.closest('.transcript-card')?.scrollIntoView({ block: 'start' });
    }
  }, [sessions.length]);

  return (
    <div
      className="sessions"
      ref={transcriptView}
      onScroll={() => {
        const view = transcriptView.current;
        if (view)
          followLatest.current = view.scrollHeight - view.scrollTop - view.clientHeight < 80;
      }}
    >
      {sessions.map((session, index) => (
        <article className="transcript-session" key={session.id}>
          <div className="session-heading">
            <span>
              <b>Session {String(index + 1).padStart(2, '0')}</b>{' '}
              <span>
                {new Date(session.started).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </span>
            <span>
              {session.languageName} · {session.mode === 'voice' ? 'Voice + text' : 'Text only'}{' '}
              <span className="session-state">
                {session.ended
                  ? session.reason === 'error' || session.reason === 'interrupted'
                    ? 'Interrupted'
                    : 'Ended'
                  : 'Live'}
              </span>
            </span>
          </div>
          {session.turns.length ? (
            session.turns.map((turn) => (
              <div className={`turn ${turn.final ? 'final' : 'provisional'}`} key={turn.id}>
                <div className="turn-meta">
                  <span className="speaker-tag">{speakerName(turn.speaker_id)}</span>
                  <span>
                    {turn.final ? 'Final' : session.ended ? 'Incomplete' : 'Updating live'}
                  </span>
                </div>
                <div className="turn-text">
                  <p className="original-text" dir="auto" lang={turn.source_language ?? undefined}>
                    {turn.source || (
                      <span className="pending-text">
                        {session.ended || turn.source_final
                          ? 'No clear speech recognized'
                          : 'Listening…'}
                      </span>
                    )}
                  </p>
                  <p className="translated-text" dir="auto" lang={session.language}>
                    <span className="reading-label">{session.languageName}</span>
                    {turn.translation || (
                      <span className="pending-text">
                        {session.ended || turn.translation_final
                          ? 'No translation returned'
                          : 'Translating…'}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            ))
          ) : (
            <div className="session-waiting">
              {session.ended
                ? 'No speech was captured in this session.'
                : 'Listening for speech. Hold the phone near the speaker.'}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
