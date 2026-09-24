import { captureEventSchema } from '../contracts';
import captureWorkletUrl from './capture.worklet.ts?worker&url';

export class AudioSession {
  private context: AudioContext;
  private stream: MediaStream | undefined;
  private source?: MediaStreamAudioSourceNode;
  private worklet: AudioWorkletNode | undefined;
  private silent?: GainNode;
  private output: GainNode;
  private scheduled = new Set<AudioBufferSourceNode>();
  private nextPlay = 0;
  private disposed = false;
  private stopped = false;
  private flushed = false;
  private flushPromise?: Promise<void>;
  private resolveFlush?: () => void;

  constructor() {
    this.context = new AudioContext();
    this.output = this.context.createGain();
    this.output.connect(this.context.destination);
  }

  async prepare(
    deviceId: string,
    playback: boolean,
    onAudio: (buffer: ArrayBuffer, level: number) => void,
    onLimit: () => void,
    onLost: () => void,
    onMicrophone: (label: string) => void,
  ): Promise<void> {
    try {
      await this.context.resume();
      const constraints: MediaTrackConstraints & { voiceIsolation: boolean } = {
        channelCount: 1,
        echoCancellation: playback,
        noiseSuppression: false,
        autoGainControl: true,
        voiceIsolation: false,
        ...(deviceId && deviceId !== 'builtin' ? { deviceId: { exact: deviceId } } : {}),
      };
      let stream = await navigator.mediaDevices.getUserMedia({
        audio: constraints,
      });
      if (this.disposed || this.stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      if (deviceId === 'builtin') {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (this.disposed || this.stopped) return;
        const builtIn = devices.find(
          (device) =>
            device.kind === 'audioinput' &&
            device.deviceId &&
            /iphone|ipad|built[ -]?in|internal|macbook/i.test(device.label) &&
            !/airpods|headset|headphone|bluetooth/i.test(device.label),
        );
        if (builtIn && builtIn.deviceId !== stream.getAudioTracks()[0]?.getSettings().deviceId) {
          stream.getTracks().forEach((track) => track.stop());
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { ...constraints, deviceId: { exact: builtIn.deviceId } },
          });
          this.stream = stream;
        }
      }
      if (this.disposed || this.stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      onMicrophone(stream.getAudioTracks()[0]?.label || 'Selected microphone');
      stream.getAudioTracks().forEach((track) => {
        track.onended = onLost;
      });
      await this.context.resume();
      await this.context.audioWorklet.addModule(captureWorkletUrl);
      if (this.disposed || this.stopped) return;
      this.worklet = new AudioWorkletNode(this.context, 'microphone-pcm');
      this.worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        const result = captureEventSchema.safeParse(event.data);
        if (!result.success) {
          onLost();
          return;
        }
        const message = result.data;
        if (message.type === 'audio') onAudio(message.buffer, message.level);
        if (message.type === 'flushed') {
          this.flushed = true;
          this.resolveFlush?.();
          if (!this.stopped) onLimit();
        }
      };
      this.worklet.onprocessorerror = onLost;
      this.source = this.context.createMediaStreamSource(stream);
      this.silent = this.context.createGain();
      this.silent.gain.value = 0;
      this.source.connect(this.worklet);
      this.worklet.connect(this.silent);
      this.silent.connect(this.context.destination);
      await this.context.resume();
      this.context.onstatechange = () => {
        if (!this.disposed && !this.stopped && this.context.state !== 'running') onLost();
      };
    } catch (error) {
      await this.dispose().catch(() => console.warn('Audio context cleanup failed.'));
      throw error;
    }
  }

  start(seconds: number) {
    if (this.disposed || this.stopped || !this.worklet)
      throw new Error('Microphone is no longer available.');
    this.worklet.port.postMessage({ type: 'start', seconds });
  }

  stop(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.stopped = true;
    this.flushPromise = (async () => {
      try {
        const worklet = this.worklet;
        if (worklet && !this.flushed && !this.disposed) {
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(
              () => reject(new Error('The microphone could not flush its final audio.')),
              1000,
            );
            this.resolveFlush = () => {
              window.clearTimeout(timeout);
              resolve();
            };
            worklet.port.postMessage({ type: 'stop' });
          });
        }
      } finally {
        this.releaseMicrophone();
      }
    })();
    return this.flushPromise;
  }

  private releaseMicrophone() {
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.worklet?.port.close();
    this.silent?.disconnect();
    this.stream = undefined;
    this.worklet = undefined;
  }

  mute(muted: boolean) {
    this.output.gain.value = muted ? 0 : 1;
  }

  play(pcm: ArrayBuffer) {
    if (this.disposed || !pcm.byteLength) return;
    if (pcm.byteLength % 2) throw new Error('Received invalid speech audio.');
    if (this.context.state !== 'running')
      throw new Error(
        'Audio playback was suspended. Keep this tab active and start a new session.',
      );
    if (this.nextPlay - this.context.currentTime > 15)
      throw new Error('Speech playback fell behind. Try text-only mode.');
    const view = new DataView(pcm);
    const buffer = this.context.createBuffer(1, pcm.byteLength / 2, 24000);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    source.onended = () => {
      this.scheduled.delete(source);
      source.disconnect();
    };
    this.scheduled.add(source);
    const start = Math.max(this.context.currentTime + 0.025, this.nextPlay);
    source.start(start);
    this.nextPlay = start + buffer.duration;
  }

  async drain() {
    while (!this.disposed && this.scheduled.size) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      if (this.context.state !== 'running') break;
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.context.onstatechange = null;
    this.resolveFlush?.();
    this.releaseMicrophone();
    for (const source of this.scheduled) {
      source.stop();
      source.disconnect();
    }
    this.scheduled.clear();
    this.output.disconnect();
    await this.context.close();
  }
}
