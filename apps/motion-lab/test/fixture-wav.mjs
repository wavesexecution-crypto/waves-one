/** Deterministic WAV fixture writer (pure PCM, no dependencies). */
import { writeFileSync } from "node:fs";

export function writeTestWav(path, { seconds = 4, bursts = [[0.2, 1.0], [1.6, 2.4], [3.0, 3.7]], rate = 16000 } = {}) {
  const samples = new Int16Array(Math.floor(rate * seconds));
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    const on = bursts.some(([a, b]) => t >= a && t < b);
    samples[i] = on ? Math.floor(Math.sin(t * 440 * Math.PI * 2) * 12000) : 0;
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length * 2, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer)]));
  return path;
}
