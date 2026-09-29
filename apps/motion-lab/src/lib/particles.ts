/**
 * Canvas particle rasterizer for dense orb states.
 *
 * This renders — it never animates. Every motion parameter comes from the
 * engine through CSS custom properties written by ordinary ops
 * (`--orb-spread`, `--orb-density`, `--orb-alpha`): same ops, same
 * validation, same timing. Seeded layouts keep frames deterministic;
 * only an ultra-slow ambient rotation uses wall time.
 */

const GOLDEN_ANGLE = 2.399963;
const MAX_PARTICLES = 600;

function readNumber(element: HTMLElement, name: string, fallback: number): number {
  const raw = getComputedStyle(element).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function hash01(index: number): number {
  const x = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function paint(canvas: HTMLCanvasElement, now: number): void {
  const host = canvas.parentElement as HTMLElement | null;
  if (!host) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const size = canvas.width;
  const spread = Math.max(0, Math.min(1.5, readNumber(host, "--orb-spread", 1)));
  const alpha = Math.max(0, Math.min(1, readNumber(host, "--orb-alpha", 1)));
  const density = Math.max(0.05, Math.min(1, readNumber(host, "--orb-density", 1)));
  if (alpha <= 0.001) {
    ctx.clearRect(0, 0, size, size);
    return;
  }
  const count = Math.max(1, Math.floor(MAX_PARTICLES * density));
  const center = size / 2;
  const radius = (size / 2) * 0.92 * spread;
  const rotation = (now / 1000) * 0.02;
  ctx.clearRect(0, 0, size, size);
  for (let index = 0; index < count; index++) {
    const fraction = (index + 0.5) / count;
    const angle = index * GOLDEN_ANGLE + rotation;
    const pointRadius = radius * Math.sqrt(fraction);
    const x = center + pointRadius * Math.cos(angle);
    const y = center + pointRadius * Math.sin(angle);
    const shade = 38 + Math.floor(hash01(index) * 150);
    const core = index === 0;
    const dotRadius = core ? size * 0.014 : size * 0.004 + hash01(index + 999) * size * 0.004;
    ctx.beginPath();
    ctx.fillStyle = core ? `rgba(228,228,231,${alpha})` : `rgba(${shade},${shade},${shade + 6},${alpha})`;
    ctx.arc(x, y, core ? dotRadius * 2.2 : dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

let running = false;

function frame(now: number): void {
  const canvases = document.querySelectorAll<HTMLCanvasElement>("canvas.lab-particle-canvas");
  if (canvases.length === 0) {
    running = false;
    return;
  }
  for (const canvas of canvases) {
    try {
      paint(canvas, now);
    } catch {
      /* one bad canvas never kills the surface */
    }
  }
  requestAnimationFrame(frame);
}

/** Start the shared rasterizer loop if a particle canvas exists. Idempotent. */
export function ensureParticles(): void {
  if (running) return;
  if (document.querySelectorAll("canvas.lab-particle-canvas").length === 0) return;
  running = true;
  requestAnimationFrame(frame);
}
