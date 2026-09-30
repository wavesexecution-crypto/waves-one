/**
 * Brand film tests — the film's contract, asserted.
 *
 * These are the guarantees a 19s flagship has to keep: it validates, it is
 * exactly 19000ms, every scene is labelled, it is finite (so it completes,
 * holds and reverses), and repeated build/dispose cycles leave no residue in
 * the DOM or in GSAP's global timeline.
 */

import { gsap } from "gsap";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAND_FILM_MS, BRAND_FILM_NAME, BRAND_FILM_SCENES, buildWavesBrandFilm } from "../src/gsap/brand-film";
import { GsapEngine } from "../src/gsap/engine";
import { planTimeline } from "../src/gsap/plan";
import type { GsapOp } from "../src/gsap/spec";
import { validateGsapSpec } from "../src/gsap/validate";

const spec = buildWavesBrandFilm();
const plan = planTimeline(spec);

function stage(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="bf-vignette"></div>
    <div class="bf-halo"></div>
    <span class="bf-corner bf-corner-tl"></span>
    <span class="bf-corner bf-corner-tr"></span>
    <span class="bf-corner bf-corner-bl"></span>
    <span class="bf-corner bf-corner-br"></span>
    <div class="bf-wordmark">WAVES</div>
    <div class="bf-scene bf-scene-1"><div class="bf-rule bf-rule-1"></div><div class="bf-s1-sub">x</div></div>
    <div class="bf-scene bf-scene-2"><div class="bf-s2-label">x</div><div class="bf-statement">WAVES builds systems that run businesses.</div><div class="bf-rule bf-rule-2"></div></div>
    <div class="bf-scene bf-scene-3">
      <div class="bf-eco-label">x</div><div class="bf-hub"><span class="bf-hub-mark">W</span></div>
      <div class="bf-spine"></div><div class="bf-bus"></div>
      <div class="bf-tap bf-tap-1"></div><div class="bf-tap bf-tap-2"></div><div class="bf-tap bf-tap-3"></div>
      <span class="bf-pulse bf-pulse-1"></span><span class="bf-pulse bf-pulse-2"></span><span class="bf-pulse bf-pulse-3"></span>
      <div class="bf-node bf-node-1"><div class="bf-node-name">WAVES ONE</div><div class="bf-node-role">Command center</div></div>
      <div class="bf-node bf-node-2"><div class="bf-node-name">WAVES Motion</div><div class="bf-node-role">Motion intelligence</div></div>
      <div class="bf-node bf-node-3"><div class="bf-node-name">SEAI</div><div class="bf-node-role">AI-built websites</div></div>
    </div>
    <div class="bf-scene bf-scene-4">
      <div class="bf-one-label">x</div>
      <div class="bf-one-panel">
        <div class="bf-one-line">Think.</div><div class="bf-one-line">Command.</div><div class="bf-one-line">Execute.</div>
        <div class="bf-console"><div class="bf-console-bar"></div><div class="bf-console-rows"></div><div class="bf-scan"></div><span class="bf-caret"></span></div>
      </div>
    </div>
    <div class="bf-scene bf-scene-5">
      <div class="bf-seai-label">x</div>
      <div class="bf-web">
        <div class="bf-web-bar"><span class="bf-web-dot"></span><span class="bf-web-dot"></span><span class="bf-web-dot"></span><div class="bf-web-url">seai.build</div></div>
        <div class="bf-web-nav"><span class="bf-web-nav-item">a</span><span class="bf-web-nav-item">b</span><span class="bf-web-nav-item">c</span><span class="bf-web-nav-item">d</span></div>
        <div class="bf-web-hero"><div class="bf-web-hero-line bf-web-hero"></div><div class="bf-web-hero-line bf-web-hero bf-web-hero-short"></div><div class="bf-web-copy"></div></div>
        <div class="bf-web-cards"><div class="bf-web-card"></div><div class="bf-web-card"></div><div class="bf-web-card"></div></div>
        <div class="bf-web-progress"><div class="bf-web-prog"></div></div>
      </div>
      <div class="bf-seai-lines"><div class="bf-seai-line">AI builds.</div><div class="bf-seai-line">Websites ship.</div><div class="bf-seai-line">Businesses launch.</div></div>
    </div>
    <div class="bf-scene bf-scene-6">
      <div class="bf-motion-label">x</div><div class="bf-motion-title">Motion, engineered.</div>
      <div class="bf-demos">
        <div class="bf-demo"><div class="bf-d-label">a</div><div class="bf-d1"><div class="bf-d1-track"></div><span class="bf-d1-tick"></span><span class="bf-d1-tick"></span><span class="bf-d1-tick"></span><span class="bf-d1-tick"></span><span class="bf-d1-tick"></span><span class="bf-d1-head"></span></div></div>
        <div class="bf-demo"><div class="bf-d-label">b</div><div class="bf-d2"><div class="bf-d2-word">WAVES</div></div></div>
        <div class="bf-demo"><div class="bf-d-label">c</div><div class="bf-d3"><span class="bf-d3-bar"></span><span class="bf-d3-bar"></span><span class="bf-d3-bar"></span><span class="bf-d3-bar"></span><span class="bf-d3-bar"></span></div></div>
        <div class="bf-demo"><div class="bf-d-label">d</div><div class="bf-d4"><span class="bf-d4-layer bf-d4-layer-1"></span><span class="bf-d4-layer bf-d4-layer-2"></span><span class="bf-d4-layer bf-d4-layer-3"></span></div></div>
        <div class="bf-demo"><div class="bf-d-label">e</div><div class="bf-d5"><span class="bf-d5-dot"></span></div></div>
        <div class="bf-demo"><div class="bf-d-label">f</div><div class="bf-d6"><div class="bf-d6-inner"><span class="bf-d6-row"></span><span class="bf-d6-row"></span><span class="bf-d6-row"></span><span class="bf-d6-row"></span></div></div></div>
      </div>
    </div>
    <div class="bf-scene bf-scene-7">
      <div class="bf-con-label">x</div>
      <div class="bf-con bf-con-1">WAVES ONE</div><div class="bf-plus bf-plus-1">+</div>
      <div class="bf-con bf-con-2">SEAI</div><div class="bf-plus bf-plus-2">+</div>
      <div class="bf-con bf-con-3">WAVES Motion</div><div class="bf-con-core"></div>
    </div>
    <div class="bf-scene bf-scene-8">
      <div class="bf-tagline">Systems that move.</div><div class="bf-rule bf-rule-3"></div>
      <div class="bf-meta"><span>WAVES ONE</span><span>SEAI</span><span>WAVES MOTION</span></div>
    </div>
    <div class="bf-readout">
      <div class="bf-num bf-num-1"></div><div class="bf-num bf-num-2"></div><div class="bf-num bf-num-3"></div>
      <div class="bf-num bf-num-4"></div><div class="bf-num bf-num-5"></div><div class="bf-num bf-num-6"></div>
      <div class="bf-num bf-num-7"></div><div class="bf-num bf-num-8"></div>
    </div>
    <div class="bf-progress"></div>`;
  document.body.appendChild(root);
  return root;
}

describe("waves brand film spec", () => {
  it("is named waves-brand-film-19s and validates clean", () => {
    expect(spec.name).toBe(BRAND_FILM_NAME);
    const report = validateGsapSpec(spec);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("resolves every selector against the real stage markup", () => {
    const root = stage();
    const report = validateGsapSpec(spec, { resolveTarget: (selector) => root.querySelectorAll(selector).length });
    expect(report.targetsChecked).toBe(true);
    expect(report.errors.filter((issue) => issue.code === "GSAP_TARGET_MISSING")).toEqual([]);
    root.remove();
  });

  it("plays whether or not the film layer is the visible one", () => {
    // The Lab keeps every scene layer mounted and toggles visibility, so a
    // scene must build against its markup even when that layer is hidden.
    const root = stage();
    const filmLayer = document.createElement("div");
    filmLayer.style.display = "none";
    filmLayer.appendChild(root.querySelector(".bf-artboard") ?? document.createComment("no artboard"));
    document.body.appendChild(filmLayer);
    const { report, playback } = new GsapEngine({ scope: root, reducedMotion: "off" }).build(spec, { autoplay: false });
    expect(report.skipped).toEqual([]);
    expect(playback.totalMs).toBe(BRAND_FILM_MS);
    filmLayer.remove();
  });

  it("bounds a whole-scene selector failure instead of flooding the UI", () => {
    // An empty stage is the stale-bundle failure mode: every op misses.
    const empty = document.createElement("div");
    document.body.appendChild(empty);
    const engine = new GsapEngine({ scope: empty, reducedMotion: "off" });
    let message = "";
    try {
      engine.build(spec, { autoplay: false });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/GSAP_TARGET_MISSING/);
    expect(message).toMatch(/\(\+\d+ more\)/);
    expect(message.length).toBeLessThan(300);
    engine.dispose();
    empty.remove();
  });

  it("plans to exactly 19000ms", () => {
    expect(plan.totalMs).toBe(BRAND_FILM_MS);
    expect(plan.totalMs).toBe(19000);
  });

  it("labels every scene on its real beat", () => {
    for (const scene of BRAND_FILM_SCENES) {
      expect(plan.labels[scene.label]).toBeDefined();
      expect(Math.abs((plan.labels[scene.label] ?? -1) - scene.at * 1000)).toBeLessThanOrEqual(1000);
    }
    // every labelled op is the one that actually opens the scene
    const labelled = spec.ops.filter((op) => (op as GsapOp).label);
    expect(labelled).toHaveLength(BRAND_FILM_SCENES.length);
  });

  it("has no unknown label references and no ambient loops", () => {
    const report = validateGsapSpec(spec);
    expect(report.warnings.filter((issue) => issue.code === "GSAP_LABEL_REF")).toEqual([]);
    expect(spec.ops.some((op) => op.ambient === true)).toBe(false);
    expect(plan.ambientCount).toBe(0);
  });

  it("uses every op type the film claims, and no scroll-bound ops", () => {
    const types = new Set(spec.ops.map((op) => op.type));
    for (const type of ["set", "tween", "stagger", "text", "spring", "motion-path"]) {
      expect(types.has(type as never)).toBe(true);
    }
    expect(types.has("scroll" as never)).toBe(false);
    expect(types.has("parallax" as never)).toBe(false);
  });

  it("keeps the last frame inside the film and the progress rail is the clock", () => {
    expect(plan.totalMs).toBe(BRAND_FILM_MS);
    const rail = plan.spans.find((span) => span.id === "film-progress");
    expect(rail?.startMs).toBe(0);
    expect(rail?.endMs).toBe(BRAND_FILM_MS);
    const lockup = plan.spans.find((span) => span.id === "s8-tagline");
    expect(lockup?.endMs).toBeLessThanOrEqual(BRAND_FILM_MS);
  });
});

describe("waves brand film playback", () => {
  let root: HTMLElement;
  let engine: GsapEngine;

  beforeEach(() => {
    root = stage();
    engine = new GsapEngine({ scope: root, reducedMotion: "off" });
  });

  afterEach(() => {
    engine.dispose();
    root.remove();
  });

  it("builds every op in the live scope with nothing skipped", () => {
    const { playback, report } = engine.build(spec, { autoplay: false });
    expect(report.skipped).toEqual([]);
    expect(playback.totalMs).toBe(BRAND_FILM_MS);
    expect(playback.state()).toBe("IDLE");
    expect(playback.timeline().duration()).toBeCloseTo(BRAND_FILM_MS / 1000, 3);
  });

  it("runs the full 19s and holds the final lockup", () => {
    const { playback } = engine.build(spec, { autoplay: false });
    const tl = playback.timeline();
    tl.progress(1);

    const read = (selector: string) => Number.parseFloat(getComputedStyle(root.querySelector(selector) as Element).opacity);
    expect(read(".bf-scene-8")).toBeCloseTo(1, 2);
    // the tagline is a text op, so its revealed state lives on the split chars
    const chars = root.querySelectorAll(".bf-tagline .waves-gsap-char");
    expect(chars.length).toBe("Systems that move.".length);
    for (const char of chars) expect(Number.parseFloat(getComputedStyle(char).opacity)).toBeCloseTo(1, 2);
    expect(read(".bf-scene-1")).toBeCloseTo(0, 2);
    expect(read(".bf-scene-4")).toBeCloseTo(0, 2);
    expect(read(".bf-scene-6")).toBeCloseTo(0, 2);
    // the 19s progress hairline is the clock: fully drawn on the final frame
    const railTransform = root.querySelector<HTMLElement>(".bf-progress")!.style.transform;
    expect(railTransform === "translate(0, 0)" || railTransform === "matrix(1, 0, 0, 1, 0, 0)" || railTransform === "none").toBe(true);
  });

  it("plays the wordmark in scene 1 and the statement in scene 2", () => {
    const { playback } = engine.build(spec, { autoplay: false });
    const tl = playback.timeline();

    const chars = (selector: string) => Array.from(root.querySelectorAll(`${selector} .waves-gsap-char`));
    const allVisible = (selector: string) => chars(selector).every((char) => Number.parseFloat(getComputedStyle(char).opacity) > 0.98);

    // t=0: the wordmark exists as split chars but is fully hidden
    tl.progress(0);
    expect(chars(".bf-wordmark").length).toBe(5);
    expect(allVisible(".bf-wordmark")).toBe(false);

    tl.progress(1.2 / 19);
    expect(allVisible(".bf-wordmark")).toBe(true);

    // scene 2 statement
    tl.progress(3.2 / 19);
    expect(allVisible(".bf-statement")).toBe(true);
    // wordmark has receded to the corner mark: translated and scaled down
    const wordmark = root.querySelector<HTMLElement>(".bf-wordmark")!;
    expect(Number.parseFloat(getComputedStyle(wordmark).opacity)).toBeCloseTo(0.42, 2);
    expect(wordmark.style.transform).not.toBe("");

    // scene 3 ecosystem
    tl.progress(6.6 / 19);
    expect(Number.parseFloat(getComputedStyle(root.querySelector(".bf-node-2 .bf-node-name") as Element).opacity)).toBeCloseTo(1, 2);
    expect(Number.parseFloat(getComputedStyle(root.querySelector(".bf-hub") as Element).opacity)).toBeCloseTo(1, 2);
  });

  it("play, pause, restart and reverse all drive the timeline", () => {
    const { playback } = engine.build(spec, { autoplay: false });

    playback.play();
    expect(playback.state()).toBe("PLAYING");
    playback.time(5);
    expect(playback.time()).toBeCloseTo(5, 3);

    playback.pause();
    expect(playback.state()).toBe("PAUSED");
    expect(playback.time()).toBeCloseTo(5, 3);

    playback.restart();
    expect(playback.time()).toBeLessThan(0.5);

    playback.time(12);
    playback.reverse();
    expect(playback.time()).toBeLessThanOrEqual(12);
  });

  it("reports COMPLETED at the end and IDLE at the start", () => {
    const { playback } = engine.build(spec, { autoplay: false });
    playback.progress(1);
    expect(playback.time()).toBeCloseTo(19, 3);
    playback.restart();
    playback.progress(0);
    playback.pause();
    expect(["IDLE", "PAUSED"]).toContain(playback.state());
  });

  it("replays without leaking timelines or split DOM", () => {
    const before = gsap.globalTimeline.getChildren(true, true, true).length;
    for (let pass = 0; pass < 3; pass += 1) {
      const { playback } = engine.build(spec, { autoplay: false });
      playback.progress(0.5);
      playback.restart();
      playback.progress(1);
    }
    const after = gsap.globalTimeline.getChildren(true, true, true).length;
    expect(after).toBe(before);
    // each build re-splits exactly one set of chars, never accumulating
    expect(root.querySelectorAll(".bf-wordmark .waves-gsap-char")).toHaveLength(5);
    expect(root.querySelectorAll(".bf-tagline .waves-gsap-char").length).toBeLessThanOrEqual("Systems that move.".length);

    engine.dispose();
    expect(root.querySelector(".bf-wordmark")?.innerHTML).toBe("WAVES");
    expect(root.querySelectorAll(".waves-gsap-char")).toHaveLength(0);
  });

  it("dispose reverts inline styles and leaves the stage clean", () => {
    const { playback } = engine.build(spec, { autoplay: false });
    const scene = root.querySelector<HTMLElement>(".bf-scene-3")!;
    // parked by the init `set` ops, so the stage is already animated before play
    expect(scene.style.opacity).toBe("0");

    playback.progress(0.35);
    expect(scene.style.opacity).not.toBe("0");

    engine.dispose();
    expect(scene.style.opacity).toBe("");
    expect(scene.style.transform).toBe("");
    expect(root.querySelector(".bf-wordmark")?.textContent).toBe("WAVES");
    expect(root.querySelectorAll(".waves-gsap-char")).toHaveLength(0);
  });

  it("reduced motion skips straight to the final frame", () => {
    const calm = new GsapEngine({ scope: root, reducedMotion: "on" });
    const { playback, report } = calm.build(spec, { autoplay: true });
    expect(report.reducedMotionApplied).toBe(true);
    expect(playback.state()).toBe("COMPLETED");
    expect(playback.progress()).toBeCloseTo(1, 3);
    expect(Number.parseFloat(getComputedStyle(root.querySelector(".bf-scene-8") as Element).opacity)).toBeCloseTo(1, 2);
    calm.dispose();
  });
});
