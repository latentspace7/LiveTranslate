import { describe, expect, it } from 'vitest';
import { PcmResampler } from './resampler';

function resample(signal: Float32Array, rate: number, blockSize: number): Int16Array {
  const converter = new PcmResampler(rate);
  const samples: number[] = [];
  for (let offset = 0; offset < signal.length; offset += blockSize) {
    samples.push(...converter.push(signal.slice(offset, offset + blockSize)));
  }
  samples.push(...converter.flush());
  return Int16Array.from(samples);
}

describe('continuous PCM resampling', () => {
  for (const rate of [16000, 44100, 48000, 96000]) {
    it(`preserves timing and block boundaries at ${rate} Hz`, () => {
      const signal = Float32Array.from(
        { length: rate },
        (_, index) => 0.5 * Math.sin((2 * Math.PI * 440 * index) / rate),
      );
      const blocked = resample(signal, rate, 128);
      const whole = resample(signal, rate, rate);
      expect(blocked.length).toBe(16000);
      expect(blocked).toEqual(whole);
      let error = 0;
      for (let i = 100; i < 15900; i++)
        error +=
          ((blocked[i] ?? NaN) / 32768 - 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000)) ** 2;
      expect(Math.sqrt(error / 15800)).toBeLessThan(0.005);
    });
  }

  it('suppresses frequencies above the output Nyquist limit', () => {
    const signal = Float32Array.from({ length: 48000 }, (_, i) =>
      Math.sin((2 * Math.PI * 12000 * i) / 48000),
    );
    const output = resample(signal, 48000, 128).slice(100, -100);
    expect(
      Math.sqrt(output.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / output.length),
    ).toBeLessThan(0.02);
  });

  it('flushes short final blocks exactly once and clips PCM safely', () => {
    const converter = new PcmResampler(48000);
    const result = [...converter.push(new Float32Array(150).fill(-2)), ...converter.flush()];
    expect(result).toHaveLength(50);
    expect(result.every((sample) => sample === -32768)).toBe(true);
    expect(converter.flush()).toHaveLength(0);
  });
});
