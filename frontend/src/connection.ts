import { AudioSession } from './audio/audio';
import { serverEventSchema } from './contracts';
import { errorMessage } from './api';
import type { Mode, Phase, Turn } from './types';

type Callbacks = {
  phase: (phase: Phase) => void;
  ready: () => void;
  turn: (turn: Turn) => void;
  level: (value: number) => void;
  microphone: (label: string) => void;
  remaining: (value: number) => void;
  error: (message: string) => void;
  ended: (reason: string) => void;
};

export class TranslationConnection {
  private audio = new AudioSession();
  private socket?: WebSocket;
  private initialized = false;
  private stopping = false;
  private closed = false;
  private disposed = false;
  private receivedEnd = false;
  private hadError = false;
  private deadlineTimer?: number;
  private countdown?: number;
  private lastAudioAt = 0;
  private offline = () =>
    this.fail(
      'Your network disconnected. Your transcript is preserved; start a new session when you are online.',
    );
  private visibility = () => {
    if (document.hidden && this.initialized && !this.closed && !this.stopping) {
      this.callbacks.error(
        'Listening stopped because the page was hidden. Keep Chrome open and your phone unlocked while listening.',
      );
      this.requestStop();
    }
  };

  constructor(private readonly callbacks: Callbacks) {
    window.addEventListener('offline', this.offline);
    document.addEventListener('visibilitychange', this.visibility);
  }

  async start(device: string, language: string, mode: Mode, muted: boolean) {
    this.callbacks.phase('preparing');
    try {
      await this.audio.prepare(
        device,
        mode === 'voice',
        (buffer, level) => {
          if (this.closed || !this.initialized) return;
          this.lastAudioAt = performance.now();
          this.callbacks.level(level);
          if (this.socket?.readyState !== WebSocket.OPEN) {
            this.fail('The connection was interrupted. Start a new session.');
            return;
          }
          if (this.socket.bufferedAmount > 64_000) {
            this.fail('Your upload connection is too slow. Start a new session when it improves.');
            return;
          }
          this.socket.send(buffer);
        },
        () => {
          this.requestStop();
        },
        () => {
          this.fail(
            'The microphone disconnected or stopped processing audio. Disconnect your headset and start again with the phone microphone.',
          );
        },
        this.callbacks.microphone,
      );
      if (this.closed) return;
      this.audio.mute(muted);
      this.callbacks.phase('connecting');
      const url = new URL('/api/translate', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.socket = new WebSocket(url);
      this.socket.binaryType = 'arraybuffer';
      this.deadlineTimer = window.setTimeout(
        () => this.fail('The connection did not become ready. Check your sign-in and try again.'),
        20_000,
      );
      this.socket.onopen = () =>
        this.socket?.send(JSON.stringify({ type: 'start', language, mode }));
      this.socket.onmessage = (event: MessageEvent<unknown>) => {
        if (this.closed) return;
        try {
          if (event.data instanceof ArrayBuffer) {
            if (mode === 'voice') this.audio.play(event.data);
            return;
          }
          if (typeof event.data !== 'string')
            throw new Error('The service sent an invalid response.');
          const parsed = serverEventSchema.safeParse(JSON.parse(event.data));
          if (!parsed.success)
            throw new Error('The service sent an invalid response. Please refresh and try again.');
          const message = parsed.data;
          if (message.type === 'ready') {
            if (this.initialized || this.stopping) return;
            window.clearTimeout(this.deadlineTimer);
            this.initialized = true;
            this.callbacks.ready();
            this.callbacks.phase('listening');
            this.audio.start(message.session_seconds);
            this.lastAudioAt = performance.now();
            const end = performance.now() + message.session_seconds * 1000;
            this.callbacks.remaining(message.session_seconds);
            this.countdown = window.setInterval(() => {
              if (performance.now() - this.lastAudioAt > 5000) {
                this.fail(
                  'Your browser stopped sending microphone audio. Disconnect your headset, keep this page open, and start again.',
                );
                return;
              }
              const remaining = Math.max(0, Math.ceil((end - performance.now()) / 1000));
              this.callbacks.remaining(remaining);
              if (!remaining) this.requestStop();
            }, 200);
          } else if (message.type === 'turn.update') {
            this.callbacks.turn(message);
          } else if (message.type === 'stopping') {
            this.requestStop();
          } else if (message.type === 'error') {
            this.hadError = true;
            this.callbacks.error(message.message);
            this.callbacks.phase('finishing');
            this.requestStop();
          } else if (message.type === 'ended') {
            this.receivedEnd = true;
            this.complete(message.reason).catch((error) => {
              if (this.disposed) return;
              this.dispose();
              this.callbacks.error(errorMessage(error, 'Could not close the audio session.'));
              this.callbacks.phase('idle');
            });
          }
        } catch (error) {
          this.fail(
            error instanceof Error ? error.message : 'The session could not process a response.',
          );
        }
      };
      this.socket.onerror = () =>
        this.fail(
          'Could not connect. Check your network and sign in again if your access expired.',
        );
      this.socket.onclose = () => {
        if (!this.closed && !this.receivedEnd)
          this.fail(
            'The connection was interrupted. Your transcript is preserved; start a new session.',
          );
      };
    } catch (error) {
      if (this.closed) return;
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      const missing =
        error instanceof DOMException &&
        ['NotFoundError', 'OverconstrainedError'].includes(error.name);
      this.fail(
        denied
          ? 'Microphone access was denied. Allow it in your browser’s site settings and try again.'
          : missing
            ? 'The selected microphone is unavailable. Choose another microphone.'
            : error instanceof Error
              ? error.message
              : 'Could not open your microphone.',
      );
    }
  }

  async stop() {
    if (this.closed || this.stopping) return;
    this.stopping = true;
    window.clearInterval(this.countdown);
    if (!this.initialized) {
      this.dispose();
      this.callbacks.phase('idle');
      return;
    }
    this.callbacks.phase('finishing');
    try {
      await this.audio.stop();
      this.callbacks.level(0);
      if (this.closed) return;
      if (this.socket?.readyState !== WebSocket.OPEN)
        throw new Error('The connection closed before the final audio was sent.');
      this.socket.send(JSON.stringify({ type: 'stop' }));
      this.deadlineTimer = window.setTimeout(
        () =>
          this.fail('The service did not finish in time. The last utterance may be incomplete.'),
        18_000,
      );
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not finish the session.');
    }
  }

  private requestStop() {
    this.stop().catch((error) => this.fail(errorMessage(error, 'Could not stop the session.')));
  }

  mute(value: boolean) {
    this.audio.mute(value);
  }

  private fail(message: string) {
    if (this.closed) return;
    if (!this.hadError) this.callbacks.error(message);
    this.hadError = true;
    this.dispose();
    this.callbacks.level(0);
    this.callbacks.ended('interrupted');
    this.callbacks.phase('idle');
  }

  private async complete(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.socket?.close();
    try {
      try {
        await this.audio.stop();
      } catch (error) {
        if (!this.disposed && !this.hadError) this.callbacks.error(errorMessage(error));
      }
      if (this.disposed) return;
      this.callbacks.level(0);
      this.callbacks.ended(reason);
      this.callbacks.phase('playing');
      await this.audio.drain();
    } finally {
      await this.audio.dispose();
      if (!this.disposed) this.callbacks.phase('idle');
    }
  }

  private clearTimers() {
    window.clearTimeout(this.deadlineTimer);
    window.clearInterval(this.countdown);
    window.removeEventListener('offline', this.offline);
    document.removeEventListener('visibilitychange', this.visibility);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    this.clearTimers();
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.socket.close();
    }
    this.audio.dispose().catch(() => console.warn('Audio context cleanup failed.'));
  }
}
