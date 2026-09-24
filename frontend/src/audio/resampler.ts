export class PcmResampler {
  private samples: number[] = [];
  private offset = 0;
  private position = 0;
  private outputIndex = 0;
  private totalInput = 0;
  private readonly ratio: number;
  private readonly radius = 24;
  private readonly cutoff: number;

  constructor(
    inputRate: number,
    private readonly outputRate = 16000,
  ) {
    if (inputRate < outputRate || !Number.isFinite(inputRate)) {
      throw new Error('Unsupported microphone sample rate.');
    }
    this.ratio = inputRate / outputRate;
    this.cutoff = 0.45 / this.ratio;
  }

  push(input: Float32Array, flush = false): Int16Array {
    for (const sample of input) this.samples.push(sample);
    this.totalInput += input.length;
    const result: number[] = [];
    const outputCount = Math.floor(this.totalInput / this.ratio);
    while (
      this.outputIndex < outputCount &&
      (flush || this.position + this.radius < this.totalInput)
    ) {
      let value = 0;
      let weight = 0;
      for (
        let index = Math.ceil(this.position - this.radius);
        index <= Math.floor(this.position + this.radius);
        index++
      ) {
        const distance = index - this.position;
        const x = 2 * this.cutoff * distance;
        const sinc = Math.abs(x) < 1e-10 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / this.radius);
        const coefficient = 2 * this.cutoff * sinc * window;
        const bounded = Math.max(0, Math.min(this.totalInput - 1, index));
        value += (this.samples[bounded - this.offset] ?? 0) * coefficient;
        weight += coefficient;
      }
      value = Math.max(-1, Math.min(1, value / weight));
      result.push(Math.round(value * (value < 0 ? 32768 : 32767)));
      this.outputIndex++;
      this.position = this.outputIndex * this.ratio;
    }
    const discard = Math.max(0, Math.floor(this.position) - this.radius - this.offset);
    if (discard > 0) {
      this.samples.splice(0, discard);
      this.offset += discard;
    }
    return Int16Array.from(result);
  }

  flush(): Int16Array {
    return this.push(new Float32Array(0), true);
  }

  get rate(): number {
    return this.outputRate;
  }
}
