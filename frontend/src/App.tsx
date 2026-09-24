import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { LoginScreen } from './LoginScreen';
import { TranscriptSessions } from './TranscriptSessions';
import { api, errorMessage } from './api';
import { authSchema, configSchema } from './contracts';
import { TranslationConnection } from './connection';
import { MicrophoneCheck } from './MicrophoneCheck';
import { transcriptText, updateTurn } from './transcripts';
import type { Config, Mode, Phase, TranscriptSession } from './types';

const phaseLabels: Record<Phase, string> = {
  idle: 'Ready when you are',
  preparing: 'Opening microphone',
  connecting: 'Connecting',
  listening: 'Listening live',
  finishing: 'Finishing translation',
  playing: 'Finishing playback',
};

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [language, setLanguage] = useState('en');
  const [mode, setMode] = useState<Mode>('text');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState('builtin');
  const [microphone, setMicrophone] = useState('');
  const [checkingMicrophone, setCheckingMicrophone] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [muted, setMuted] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [level, setLevel] = useState(0);
  const [remaining, setRemaining] = useState(240);
  const [sessions, setSessions] = useState<TranscriptSession[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const connection = useRef<TranslationConnection | null>(null);
  const configRequest = useRef<AbortController | null>(null);
  const lastSound = useRef(0);
  const busy = phase !== 'idle';
  const selected = config?.languages.find((item) => item.code === language);
  const hasText = sessions.some((session) =>
    session.turns.some((turn) => turn.source || turn.translation),
  );
  const meter =
    phase === 'listening'
      ? Math.max(0, Math.min(1, (20 * Math.log10(Math.max(level, 0.000001)) + 60) / 60))
      : 0;
  const secure =
    window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!window.AudioWorkletNode;

  const loadConfig = useCallback(() => {
    configRequest.current?.abort();
    const controller = new AbortController();
    configRequest.current = controller;
    return api('/config', configSchema, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        setConfig(value);
        setLanguage(value.defaults.language);
        setMode(value.defaults.mode);
        setRemaining(value.session_seconds);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) throw cause;
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api('/auth/session', authSchema, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setAuthenticated(result.authenticated);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setAuthenticated(false);
          setError('Could not reach the server. Please try again.');
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    loadConfig().catch((cause) => setError(errorMessage(cause)));
    return () => configRequest.current?.abort();
  }, [authenticated, loadConfig]);

  useEffect(() => {
    if (phase !== 'listening') return;
    lastSound.current = performance.now();
    const timer = window.setInterval(
      () => setQuiet(performance.now() - lastSound.current > 8000),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [phase]);

  const refreshDevices = useCallback(() => {
    return (navigator.mediaDevices?.enumerateDevices() ?? Promise.resolve([]))
      .then((list) => {
        setDevices(list.filter((item) => item.kind === 'audioinput'));
      })
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    refreshDevices().catch((cause) => setError(errorMessage(cause)));
    const refresh = () => {
      refreshDevices().catch((cause) => setError(errorMessage(cause)));
    };
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, [authenticated, refreshDevices]);

  useEffect(() => {
    const dispose = () => {
      connection.current?.dispose();
    };
    window.addEventListener('pagehide', dispose);
    return () => {
      window.removeEventListener('pagehide', dispose);
      dispose();
    };
  }, []);

  async function login(password: string) {
    const result = await api('/auth/login', authSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setAuthenticated(result.authenticated);
  }

  async function logout() {
    configRequest.current?.abort();
    connection.current?.dispose();
    setLevel(0);
    setPhase('idle');
    try {
      await api('/auth/logout', authSchema, { method: 'POST' });
      setAuthenticated(false);
      setConfig(null);
      setSessions([]);
      setError('');
      setNotice('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function start() {
    if (!config || busy || checkingMicrophone) return;
    setError('');
    setNotice('');
    setMicrophone('');
    setQuiet(false);
    const id = crypto.randomUUID();
    const languageName = selected?.name ?? language;
    const sessionMode = selected?.audio ? mode : 'text';
    try {
      connection.current = new TranslationConnection({
        phase: setPhase,
        ready: () => {
          setSessions((previous) => [
            ...previous,
            {
              id,
              started: new Date().toISOString(),
              language,
              languageName,
              mode: sessionMode,
              turns: [],
              ended: false,
            },
          ]);
          refreshDevices().catch((cause) => setError(errorMessage(cause)));
        },
        turn: (turn) => {
          if (turn.final && !turn.source.trim() && !turn.translation.trim()) {
            setNotice(
              'No clear speech was recognized. For nearby conversations, disconnect your headset and hold the phone closer to the speaker.',
            );
          } else if (turn.source.trim() || turn.translation.trim()) {
            setNotice('');
          }
          setSessions((previous) =>
            previous.map((session) =>
              session.id === id ? { ...session, turns: updateTurn(session.turns, turn) } : session,
            ),
          );
        },
        level: (value) => {
          setLevel(value);
          if (value > 0.001) lastSound.current = performance.now();
        },
        microphone: setMicrophone,
        remaining: setRemaining,
        error: setError,
        ended: (reason) => {
          setSessions((previous) =>
            previous.map((session) =>
              session.id === id ? { ...session, ended: true, reason } : session,
            ),
          );
          if (reason === 'expired') {
            setRemaining(0);
            setNotice('Four minutes complete. Start a new session to keep the conversation going.');
          } else if (reason === 'stopped')
            setNotice('Session complete. Your transcript is ready to copy or download.');
        },
      });
      connection.current.start(device, language, sessionMode, muted).catch((cause) => {
        setError(errorMessage(cause));
        connection.current?.dispose();
        setPhase('idle');
      });
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase('idle');
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(transcriptText(sessions));
      setNotice('Transcript copied.');
    } catch {
      setError('Clipboard access is unavailable. Use Download instead.');
    }
  }

  function download() {
    const url = URL.createObjectURL(
      new Blob([transcriptText(sessions)], { type: 'text/plain;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `livetranslate-${new Date().toISOString().slice(0, 10)}.txt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className={`app-shell ${busy ? 'session-active' : ''}`}>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" translate="no" href="/" aria-label="LiveTranslate home">
          <span className="brand-mark">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>LiveTranslate</span>
        </a>
        <div className="topbar-right">
          <span className="private-badge">
            <Icon name="lock" size={13} /> Private workspace
          </span>
          {authenticated && (
            <button
              className="text-button"
              onClick={() => {
                logout().catch((cause) => setError(errorMessage(cause)));
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </header>
      <main id="content" tabIndex={-1}>
        {!authenticated ? (
          <LoginScreen
            checkingAccess={authenticated === null}
            error={error}
            onLogin={login}
            onError={setError}
          />
        ) : (
          <>
            <section className="page-heading">
              <div>
                <div className="eyebrow">YOUR POCKET TRAVEL COMPANION</div>
                <h1>Feel at home, anywhere.</h1>
                <p>From market stalls to little cafés, follow the conversation.</p>
              </div>
              <div className="session-chip">
                <span className={phase === 'listening' ? 'status-dot active' : 'status-dot'} />{' '}
                <span role="status">{phaseLabels[phase]}</span>
              </div>
            </section>
            {!secure && (
              <div className="message error" role="alert">
                Microphone capture needs HTTPS and a browser with AudioWorklet support.
              </div>
            )}
            {error && (
              <div className="message error" role="alert">
                <span>{error}</span>
                <button aria-label="Dismiss error" onClick={() => setError('')}>
                  ×
                </button>
              </div>
            )}
            {notice && (
              <div className="message notice" role="status">
                {notice}
              </div>
            )}
            {!config && (
              <div className="message notice">
                Loading workspace settings…{' '}
                <button
                  onClick={() => {
                    loadConfig().catch((cause) => setError(errorMessage(cause)));
                  }}
                >
                  Retry
                </button>
              </div>
            )}
            <section className="controls-card" aria-label="Translation settings">
              <div className="language-controls">
                <div className="source-language">
                  <span className="field-label">Speaking in</span>
                  <div>
                    <Icon name="globe" />
                    <strong>Auto-detect</strong>
                    <span className="small-pill">AUTO</span>
                  </div>
                  <p>Just speak in your language</p>
                </div>
                <span className="direction">
                  <Icon name="arrow" />
                </span>
                <div className="target-language">
                  <label htmlFor="target">Translate to</label>
                  <select
                    id="target"
                    value={language}
                    onChange={(event) => {
                      setLanguage(event.target.value);
                      if (
                        !config?.languages.find((item) => item.code === event.target.value)?.audio
                      )
                        setMode('text');
                    }}
                    disabled={!config}
                  >
                    {config?.languages.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.name}
                        {item.audio ? '' : ' · text only'}
                      </option>
                    ))}
                  </select>
                  <p>
                    {selected?.audio
                      ? 'Text and spoken translation available'
                      : 'Text translation available'}
                  </p>
                </div>
              </div>
              <div className="controls-divider" />
              <div className="device-controls">
                <div className="microphone-control">
                  <label htmlFor="microphone">
                    <Icon name="mic" size={15} /> Microphone
                  </label>
                  <select
                    id="microphone"
                    value={device}
                    onChange={(event) => setDevice(event.target.value)}
                    disabled={busy || checkingMicrophone}
                  >
                    <option value="builtin">Built-in microphone</option>
                    <option value="">System default / headset</option>
                    {devices
                      .filter((item) => item.deviceId && item.deviceId !== 'default')
                      .map((item, index) => (
                        <option key={item.deviceId} value={item.deviceId}>
                          {item.label || `Microphone ${index + 1}`}
                        </option>
                      ))}
                  </select>
                </div>
                <fieldset className="mode-control">
                  <legend>Translation output</legend>
                  <div className="segmented-control">
                    <button
                      type="button"
                      aria-pressed={mode === 'voice'}
                      disabled={!selected?.audio}
                      onClick={() => setMode('voice')}
                    >
                      <Icon name="volume" size={16} /> Voice + text
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === 'text'}
                      onClick={() => setMode('text')}
                    >
                      Text only
                    </button>
                  </div>
                </fieldset>
                <div className="start-control">
                  {busy ? (
                    <button
                      className="stop-button"
                      disabled={phase === 'finishing' || phase === 'playing'}
                      onClick={() => {
                        connection.current?.stop().catch((cause) => setError(errorMessage(cause)));
                      }}
                    >
                      <Icon name="stop" size={18} />
                      {phase === 'preparing' || phase === 'connecting'
                        ? 'Cancel'
                        : phase === 'finishing' || phase === 'playing'
                          ? 'Finishing…'
                          : 'Stop session'}
                    </button>
                  ) : (
                    <button
                      className="primary-button"
                      disabled={!secure || !config || checkingMicrophone}
                      onClick={start}
                    >
                      <Icon name="mic" size={18} />
                      {sessions.length ? 'Start new session' : 'Start translating'}
                    </button>
                  )}
                </div>
              </div>
              <MicrophoneCheck
                device={device}
                disabled={busy || !secure}
                onChecking={setCheckingMicrophone}
              />
              <div className="controls-foot">
                <span>
                  For nearby conversations, use the phone microphone with your headset disconnected.
                </span>
                <span>
                  {busy
                    ? 'Language and output changes apply to your next session.'
                    : 'Up to 4 minutes per session · Restart anytime'}
                </span>
              </div>
            </section>
            <section className="transcript-card" aria-label="Conversation transcript">
              <div className="transcript-toolbar">
                <div className="transcript-title">
                  <h2>Conversation</h2>
                  <span className="count-badge">
                    {sessions.reduce((sum, session) => sum + session.turns.length, 0)}
                  </span>
                </div>
                <div className="transcript-actions">
                  <button
                    title={muted ? 'Unmute playback' : 'Mute playback'}
                    aria-label={muted ? 'Unmute playback' : 'Mute playback'}
                    aria-pressed={muted}
                    onClick={() => {
                      setMuted(!muted);
                      connection.current?.mute(!muted);
                    }}
                  >
                    <Icon name={muted ? 'mute' : 'volume'} size={18} />
                    <span>{muted ? 'Muted' : 'Playback'}</span>
                  </button>
                  <span className="toolbar-divider" />
                  <button
                    aria-label="Copy transcript"
                    title="Copy transcript"
                    disabled={!hasText}
                    onClick={() => {
                      copy().catch((cause) => setError(errorMessage(cause)));
                    }}
                  >
                    <Icon name="copy" size={17} />
                    <span>Copy</span>
                  </button>
                  <button
                    aria-label="Download transcript"
                    title="Download transcript"
                    disabled={!hasText}
                    onClick={download}
                  >
                    <Icon name="download" size={18} />
                    <span>Download</span>
                  </button>
                </div>
              </div>
              {busy && microphone && (
                <div className={`capture-status ${quiet ? 'quiet' : ''}`}>
                  <div className="capture-device">
                    <Icon name="mic" size={16} />
                    <span>{microphone}</span>
                  </div>
                  <div className="capture-level">
                    <div
                      className="level-meter"
                      role="meter"
                      aria-label="Live microphone level"
                      aria-valuenow={Math.round(meter * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      {Array.from({ length: 12 }, (_, index) => (
                        <i key={index} className={index < meter * 12 ? 'lit' : ''} />
                      ))}
                    </div>
                    <span>
                      {phase !== 'listening'
                        ? phaseLabels[phase]
                        : quiet
                          ? 'Very quiet'
                          : level > 0.001
                            ? 'Sound detected'
                            : 'Listening for sound'}
                    </span>
                  </div>
                  {quiet && (
                    <p>
                      Move the phone closer to the speaker. If a headset is connected, disconnect it
                      and start again.
                    </p>
                  )}
                  {phase === 'listening' && !quiet && (
                    <p>Text updates as people speak. Stop only ends the session.</p>
                  )}
                </div>
              )}
              <div className="column-labels">
                <span>
                  ORIGINAL <span>Auto-detected</span>
                </span>
                <span>
                  TRANSLATION <span>{selected?.name ?? 'English'}</span>
                </span>
              </div>
              {!sessions.length ? (
                <div className="empty-state">
                  <div className="sound-illustration" aria-hidden="true">
                    {[16, 30, 49, 68, 40, 25, 52, 34, 16].map((height, index) => (
                      <i key={index} style={{ height }} />
                    ))}
                  </div>
                  <h3>A conversation starts with a word.</h3>
                  <p>
                    Tap Start translating and let your microphone listen.
                    <br />
                    {selected?.name ?? 'English'} translations appear here as people speak.
                  </p>
                  <span className="empty-caption">
                    <span className="status-dot" /> Ready to listen
                  </span>
                </div>
              ) : (
                <TranscriptSessions sessions={sessions} />
              )}
              <div className="transcript-footer">
                <div className="input-status">
                  <div
                    className="level-meter"
                    role="meter"
                    aria-label="Microphone level"
                    aria-valuenow={Math.round(Math.min(1, level * 5) * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    {Array.from({ length: 12 }, (_, index) => (
                      <i
                        key={index}
                        className={phase === 'listening' && index < level * 60 ? 'lit' : ''}
                      />
                    ))}
                  </div>
                  <span>{phase === 'listening' ? 'Microphone on' : 'Microphone off'}</span>
                </div>
                <div className="transcript-bottom-right">
                  <span className="countdown" aria-label="Session time remaining">
                    {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}{' '}
                    <span>/ 4:00</span>
                  </span>
                  <button
                    className="text-button"
                    disabled={busy || !sessions.length}
                    onClick={() => {
                      setSessions([]);
                      setNotice('');
                      setRemaining(config?.session_seconds ?? 240);
                    }}
                  >
                    Clear transcript
                  </button>
                </div>
              </div>
            </section>
            {busy && (
              <div className="mobile-listening-bar">
                <div>
                  <span className={phase === 'listening' ? 'status-dot active' : 'status-dot'} />
                  <span>{phaseLabels[phase]}</span>
                  <b>
                    {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
                  </b>
                </div>
                <button
                  className="stop-button"
                  disabled={phase === 'finishing' || phase === 'playing'}
                  onClick={() => {
                    connection.current?.stop().catch((cause) => setError(errorMessage(cause)));
                  }}
                >
                  <Icon name="stop" size={16} />
                  {phase === 'preparing' || phase === 'connecting' ? 'Cancel' : 'Stop'}
                </button>
              </div>
            )}
            <footer className="page-footer">
              <span>
                <Icon name="lock" size={13} /> Transcript stays in this tab until you clear it or
                close the page.
              </span>
              <span>Audio is sent for live translation.</span>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
