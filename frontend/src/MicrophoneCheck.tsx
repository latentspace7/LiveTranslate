import { useEffect, useRef, useState } from 'react';
import { AudioSession } from './audio/audio';

type Props = {
  device: string;
  disabled: boolean;
  onChecking: (checking: boolean) => void;
};

function recordingUrl(chunks: ArrayBuffer[]) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + size, true);
  write(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, size, true);
  return URL.createObjectURL(new Blob([header, ...chunks], { type: 'audio/wav' }));
}

export function MicrophoneCheck({ device, disabled, onChecking }: Props) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState('');
  const [seconds, setSeconds] = useState(5);
  const capture = useRef<AudioSession | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel.current?.();
      capture.current?.dispose().catch(() => console.warn('Microphone check cleanup failed.'));
    };
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  useEffect(() => {
    if (disabled) player.current?.pause();
  }, [disabled]);

  async function check() {
    if (checking || disabled) return;
    setChecking(true);
    onChecking(true);
    setPreview('');
    setSeconds(5);
    setMessage('Opening microphone…');
    const chunks: ArrayBuffer[] = [];
    let bytes = 0;
    let peak = 0;
    let session: AudioSession | undefined;
    let timer: number | undefined;
    let finish: (() => void) | undefined;
    let fail: (() => void) | undefined;
    let complete = false;
    try {
      session = new AudioSession();
      capture.current = session;
      await session.prepare(
        device,
        false,
        (buffer) => {
          chunks.push(buffer);
          bytes += buffer.byteLength;
          const view = new DataView(buffer);
          for (let offset = 0; offset < buffer.byteLength; offset += 2)
            peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
          setSeconds(Math.max(0, Math.ceil(5 - bytes / 32000)));
        },
        () => {
          complete = true;
          finish?.();
        },
        () => fail?.(),
        (label) => {
          setMessage(`Speak for five seconds into ${label}.`);
        },
      );
      if (!mounted.current) return;
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = () => reject(new Error('The microphone stopped. Try starting the check again.'));
        cancel.current = fail;
        timer = window.setTimeout(
          () =>
            reject(
              new Error(
                'The microphone did not send enough audio. Close other apps using the microphone and try again.',
              ),
            ),
          8000,
        );
        capture.current?.start(5);
        if (complete) resolve();
      });
      await session.stop();
      if (!mounted.current) return;
      if (!chunks.length) throw new Error('No audio was captured.');
      setPreview(recordingUrl(chunks));
      setMessage(
        `${peak < 1000 ? 'The captured audio is very quiet. ' : ''}Press play. You should hear your words clearly. This check stays on your phone.`,
      );
    } catch (error) {
      if (mounted.current)
        setMessage(error instanceof Error ? error.message : 'Could not check the microphone.');
    } finally {
      window.clearTimeout(timer);
      cancel.current = null;
      await session?.dispose().catch(() => {
        if (mounted.current)
          setMessage('Could not close the microphone check. Refresh before trying again.');
      });
      capture.current = null;
      if (mounted.current) {
        setChecking(false);
        onChecking(false);
      }
    }
  }

  return (
    <div className="microphone-check">
      <button
        className="text-button"
        disabled={disabled || checking}
        onClick={() => {
          check().catch(() => setMessage('Could not complete the microphone check.'));
        }}
      >
        {checking ? `Recording check… ${seconds}s` : 'Check microphone'}
      </button>
      {message && <p role="status">{message}</p>}
      {preview && (
        <audio ref={player} controls src={preview} aria-label="Microphone check recording" />
      )}
    </div>
  );
}
