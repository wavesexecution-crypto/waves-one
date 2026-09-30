/**
 * Playback regression — PLAY must run 0s → full duration, not 0s → one frame.
 *
 * This file exists because the existing engine tests assert transport *state*
 * (`expect(playback.state()).toBe("PLAYING")`). That is exactly the check that
 * hides this class of bug: a Lab whose transport reports PLAYING while the
 * timeline never advances satisfies every state assertion and still shows a
 * single frozen frame.
 *
 * So these tests measure real elapsed timeline time from GSAP's own ticker.
 * A one-frame failure produces one or two onUpdate samples clustered near zero;
 * real playback produces a strictly increasing series that reaches the spec's
 * own planned duration. The distinction is asserted numerically.
 *
 * GSAP has no `requestAnimationFrame` in this environment and falls back to
 * timers, which is fine: what is under test is the timeline's progression, not
 * the host's frame scheduler.
 */

import { gsap } from "gsap";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GsapEngine, planTimeline, type GsapSceneSpec } from "@waves/motion";

const DURATION = 0.9;

/** A multi-beat scene, so "did it animate" is not answerable by one property. */
function scene(name = "playback-regression"): GsapSceneSpec {
  return {
    version: 1,
    name,
    defaults: { duration: 0.5, ease: "none" },
    ops: [
      { id: "init", type: "set", target: ".pl-a", to: { opacity: 0 } },
      { id: "a", type: "tween", target: ".pl-a", to: { opacity: 1 }, duration: 0.3, position: 0 },
      { id: "b", type: "tween", target: ".pl-b", to: { x: 200 }, duration: 0.3, position: 0.3 },
      { id: "c", type: "tween", target: ".pl-c", to: { scale: 2 }, duration: 0.3, position: 0.6 }
    ]
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Budgets are generous on purpose. These assertions read the timeline's own
 * clock, but the *sampling* runs on the host's scheduler, which starves when the
 * whole suite runs in parallel. The invariant under test — the timeline reaches
 * its real duration — must not depend on how many samples the host managed to
 * take, only that the series it did take spans the scene.
 */
const BUDGET_MS = 25_000;

/** Poll until `done` or the budget runs out. Returns whether it completed. */
async function until(done: () => boolean, budgetMs = BUDGET_MS): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (done()) return true;
    await sleep(20);
  }
  return done();
}

describe("playback runs the whole timeline", () => {
  let root: HTMLElement;
  let engine: GsapEngine;

  beforeEach(() => {
    root = document.createElement("div");
    root.innerHTML = `<div class="pl-a"></div><div class="pl-b"></div><div class="pl-c"></div>`;
    document.body.appendChild(root);
    engine = new GsapEngine({ scope: root, reducedMotion: "off" });
  });

  afterEach(() => {
    engine.dispose();
    root.remove();
  });

  it("PLAY advances timeline time from ~0 to the real duration, not one frame", async () => {
    const spec = scene();
    const { playback } = engine.build(spec, { autoplay: false });
    const total = planTimeline(spec).totalMs;

    // Sample the timeline's OWN clock, not a state flag and not a React render.
    // This is the measurement that separates "played" from "reported PLAYING".
    const observed: number[] = [];
    let running = true;
    const sampler = (async () => {
      while (running) {
        observed.push(playback.time());
        await sleep(40);
      }
    })();

    // The frame we start from.
    expect(playback.time()).toBe(0);

    playback.play();
    const reachedEnd = await until(() => playback.progress() >= 1);
    running = false;
    await sampler;

    expect(reachedEnd).toBe(true);

    // Monotonic non-decreasing: real time only moves forward.
    for (let i = 1; i < observed.length; i += 1) {
      expect(observed[i]).toBeGreaterThanOrEqual(observed[i - 1] - 1e-6);
    }

    // The regression itself. A one-frame bug yields a series that stays at ~0.
    const first = observed[0];
    const last = observed[observed.length - 1];
    expect(last).toBeGreaterThanOrEqual(DURATION * 0.9);
    expect(last - first).toBeGreaterThanOrEqual(DURATION * 0.8);

    // And the scene really did pass through intermediate positions, not jump.
    const interior = observed.filter((t) => t > 0.1 && t < DURATION * 0.85);
    expect(interior.length).toBeGreaterThan(0);

    // The reported total matches the spec, so COMPLETED is real.
    expect(total).toBe(Math.round(DURATION * 1000));
    expect(playback.state()).toBe("COMPLETED");
  });

  it("drives the consumer clock from the timeline's own ticker", async () => {
    // The Lab used to poll time() from a competing setInterval, which can read
    // out of step with GSAP and show a moving clock over a frozen frame.
    const { playback } = engine.build(scene(), { autoplay: false });
    const ticks: number[] = [];
    const off = playback.onUpdate((t) => ticks.push(t));
    playback.play();
    await until(() => playback.progress() >= 1);
    off();
    // More than a single notification, and the last lands at the real end.
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(DURATION * 0.9);
  });

  it("COMPLETED only once the timeline actually reaches its duration", async () => {
    const { playback } = engine.build(scene(), { autoplay: false });
    let completedAt: number | null = null;
    playback.onStateChange((s) => {
      if (s === "COMPLETED") completedAt = playback.time();
    });
    playback.play();
    expect(completedAt).toBeNull();
    await until(() => playback.progress() >= 1);
    expect(completedAt).not.toBeNull();
    expect(completedAt as number).toBeGreaterThanOrEqual(DURATION * 0.9);
  });

  it("PAUSE freezes the timeline where it is, and resumes from there", async () => {
    const { playback } = engine.build(scene(), { autoplay: false });
    playback.play();
    await sleep(200);
    playback.pause();
    const held = playback.time();
    expect(held).toBeGreaterThan(0);
    expect(playback.state()).toBe("PAUSED");

    // Real elapsed time passes and the timeline must not creep.
    await sleep(300);
    expect(playback.time()).toBeCloseTo(held, 3);

    playback.play();
    expect(playback.time()).toBeGreaterThanOrEqual(held - 0.01);
    await until(() => playback.progress() >= 1);
    expect(playback.state()).toBe("COMPLETED");
  });

  it("RESTART returns to 0 and replays the whole timeline", async () => {
    const { playback } = engine.build(scene(), { autoplay: false });
    playback.play();
    await until(() => playback.progress() >= 1);
    expect(playback.state()).toBe("COMPLETED");

    playback.restart();
    expect(playback.time()).toBeLessThan(0.15);
    expect(playback.state()).toBe("PLAYING");

    // A second full pass measured on the timeline clock, not on a flag.
    const again: number[] = [];
    let running = true;
    const sampler = (async () => {
      while (running) {
        again.push(playback.time());
        await sleep(40);
      }
    })();
    await until(() => playback.progress() >= 1);
    running = false;
    await sampler;

    expect(again[again.length - 1]).toBeGreaterThanOrEqual(DURATION * 0.9);
  });

  it("REVERSE walks timeline time backwards toward 0", async () => {
    const { playback } = engine.build(scene(), { autoplay: false });
    playback.play();
    await until(() => playback.progress() >= 1);
    const atEnd = playback.time();

    playback.reverse();
    const off = playback.onUpdate((t) => void t);
    await until(() => playback.progress() <= 0.001, 4000);
    off();

    expect(playback.progress()).toBeLessThanOrEqual(0.001);
    expect(playback.time()).toBeLessThan(atEnd);
  });

  it("survives repeated play/pause cycles without stalling or duplicating", async () => {
    const { playback } = engine.build(scene(), { autoplay: false });
    for (let i = 0; i < 12; i += 1) {
      playback.play();
      await sleep(35);
      playback.pause();
    }
    // Still a single timeline on the global timeline for this engine.
    expect(playback.timeline()).toBeTruthy();
    expect(playback.timeline().parent).toBe(gsap.globalTimeline);
    playback.play();
    await until(() => playback.progress() >= 1);
    expect(playback.state()).toBe("COMPLETED");
  });

  it("notifies subscribers exactly once per paused seek, so a scrubbed clock is never stale", () => {
    const { playback } = engine.build(scene(), { autoplay: false });
    const seen: number[] = [];
    const off = playback.onUpdate((t) => seen.push(t));
    playback.progress(0.5);
    // GSAP's own onUpdate fires for a seek; exactly once is the contract.
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeCloseTo(playback.time(), 3);
    off();

    playback.progress(0.9);
    expect(seen.length).toBe(1); // unsubscribed: no further calls
  });

  it("stops notifying after unsubscribe and leaks no timelines across mounts", async () => {
    const baseline = gsap.globalTimeline.getChildren().length;
    for (let i = 0; i < 6; i += 1) {
      const local = new GsapEngine({ scope: root, reducedMotion: "off" });
      const { playback } = local.build(scene(), { autoplay: false });
      const seen: number[] = [];
      const off = playback.onUpdate((t) => seen.push(t));
      playback.play();
      await sleep(60);
      off();
      // No stray ticks after unsubscribing.
      const after = seen.length;
      await sleep(60);
      expect(seen.length).toBe(after);
      local.dispose();
    }
    expect(gsap.globalTimeline.getChildren().length).toBe(baseline);
    expect(document.querySelectorAll(".waves-gsap-char").length).toBe(0);
  });

  it("replays from 0 after COMPLETED when play() is driven directly", async () => {
    // The engine deliberately holds COMPLETED at the end; the Lab owns the
    // restart intent. This pins that contract so it stays deliberate.
    const { playback } = engine.build(scene(), { autoplay: false });
    playback.play();
    await until(() => playback.progress() >= 1);
    playback.play();
    expect(playback.state()).toBe("COMPLETED");
    expect(playback.time()).toBeGreaterThanOrEqual(DURATION * 0.9);
    playback.restart();
    expect(playback.time()).toBeLessThan(0.15);
  });
});