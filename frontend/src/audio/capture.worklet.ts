import { PcmResampler } from './resampler';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class MicrophoneProcessor extends AudioWorkletProcessor {
  private resampler = new PcmResampler(sampleRate);
  private chunk = new Int16Array(1600);
  private filled = 0;
  private enabled = false;
  private total = 0;
  private limit = 240 * 16000;
  private finished = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      const control = event.data;
      if (!control || typeof control !== 'object' || !('type' in control)) return;
      if (
        control.type === 'start' &&
        'seconds' in control &&
        typeof control.seconds === 'number' &&
        Number.isFinite(control.seconds) &&
        control.seconds > 0 &&
        control.seconds <= 240 &&
        !this.finished
      ) {
        this.limit = Math.floor(control.seconds * 16000);
        this.enabled = true;
      }
      if (control.type === 'stop') this.finish();
    };
  }

  private emit() {
    if (!this.filled) return;
    const buffer = new ArrayBuffer(this.filled * 2);
    const view = new DataView(buffer);
    let power = 0;
    for (let i = 0; i < this.filled; i++) {
      const sample = this.chunk[i] ?? 0;
      view.setInt16(i * 2, sample, true);
      power += (sample / 32768) ** 2;
    }
    this.port.postMessage({ type: 'audio', buffer, level: Math.sqrt(power / this.filled) }, [
      buffer,
    ]);
    this.filled = 0;
  }

  private append(samples: Int16Array) {
    for (const sample of samples) {
      if (this.total >= this.limit) break;
      this.chunk[this.filled++] = sample;
      this.total++;
      if (this.filled === this.chunk.length) this.emit();
    }
  }

  private finish() {
    if (this.finished) return;
    this.enabled = false;
    this.finished = true;
    this.append(this.resampler.flush());
    this.emit();
    this.port.postMessage({ type: 'flushed' });
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.enabled) return true;
    const channels = inputs[0];
    const first = channels?.[0];
    if (!channels || !first) return true;
    const mono = new Float32Array(first.length);
    for (const channel of channels) {
      for (let i = 0; i < mono.length; i++)
        mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / channels.length;
    }
    this.append(this.resampler.push(mono));
    if (this.total >= this.limit) this.finish();
    return true;
  }
}

registerProcessor('microphone-pcm', MicrophoneProcessor);
