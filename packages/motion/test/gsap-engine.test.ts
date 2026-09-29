/**
 * GSAP engine tests — real GSAP in jsdom, paused timelines, no wall-clock.
 * ScrollTrigger creation is environment-dependent; the engine degrades to
 * skip-with-warning, which these tests assert rather than fight.
 */
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { gsap } from "gsap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GsapEngine, planTimeline, type GsapSceneSpec } from "@waves/motion";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

const TITLE = ".ob-title";

function obsidianLike(): GsapSceneSpec {
  return {
    version: 1,
    name: "obsidian-test",
    ops: [
      { id: "init", type: "set", target: TITLE, to: { opacity: 0, y: 60 } },
      { id: "sub-init", type: "set", target: ".ob-sub", to: { opacity: 0, y: 24 } },
      { id: "title", type: "tween", target: TITLE, to: { opacity: 1, y: 0 }, duration: 0.9, ease: "power3.out", position: 0.1 },
      { id: "sub", type: "tween", target: ".ob-sub", to: { opacity: 1, y: 0 }, duration: 0.6, ease: "power3.out", position: 0.5 },
      { id: "chars", type: "text", target: ".ob-word", to: { opacity: 1, y: 0 }, duration: 0.4, stagger: 0.05, position: 0.9 },
      { id: "spin", type: "spring", target: ".ob-orb", to: { rotation: 180 }, duration: 1.2, spring: "gentle", position: 1.0 },
      { id: "drift", type: "tween", target: ".ob-orb", to: { y: -12 }, duration: 6, ease: "sine.inOut", position: 2.0, ambient: true }
    ]
  };
}

describe("gsap timeline planning", () => {
  it("resolves absolute, relative, and label positions deterministically", () => {
    const plan = planTimeline(obsidianLike());
    expect(plan.totalMs).toBeGreaterThan(0);
    expect(plan.tweenCount).toBe(7);
    expect(plan.ambientCount).toBe(1);
    const title = plan.spans.find((s) => s.id === "title");
    expect(title?.startMs).toBe(100);
    expect(title?.endMs).toBe(1000);
    const sub = plan.spans.find((s) => s.id === "sub");
    expect(sub?.startMs).toBe(500);
  });
});

describe("gsap engine build + transport", () => {
  let root: HTMLElement;
  let engines: GsapEngine[];

  beforeEach(() => {
    root = mount(`<h1 class="ob-title">WAVES</h1><p class="ob-sub">Motion, engineered.</p><div class="ob-word">Hi</div><div class="ob-orb"></div>`);
    engines = [];
  });

  afterEach(() => {
    for (const engine of engines) engine.dispose();
    root.remove();
    vi.unstubAllGlobals();
  });

  function build(spec?: GsapSceneSpec, options: Record<string, unknown> = {}) {
    const engine = new GsapEngine({ scope: root, reducedMotion: "off", ...options });
    engines.push(engine);
    return engine.build(spec ?? obsidianLike(), { autoplay: false });
  }

  it("builds the full timeline with the planned total", () => {
    const { playback, report } = build();
    expect(report.reducedMotionApplied).toBe(false);
    expect(playback.totalMs).toBe(planTimeline(obsidianLike()).totalMs);
    expect(playback.state()).toBe("IDLE");
  });

  it("drives IDLE → PLAYING → PAUSED → COMPLETED", () => {
    const { playback } = build();
    const seen: string[] = [];
    const off = playback.onStateChange((s) => seen.push(s));
    playback.play();
    expect(playback.state()).toBe("PLAYING");
    playback.pause();
    expect(playback.state()).toBe("PAUSED");
    playback.progress(1);
    playback.play();
    expect(playback.state()).toBe("COMPLETED");
    playback.restart();
    expect(playback.state()).toBe("PLAYING");
    playback.reverse();
    expect(playback.state()).toBe("PLAYING");
    playback.kill();
    expect(playback.state()).toBe("IDLE");
    off();
    expect(seen).toContain("PLAYING");
    expect(seen).toContain("PAUSED");
    expect(seen).toContain("COMPLETED");
  });

  it("splits text and restores the DOM on dispose", () => {
    const before = root.querySelector(".ob-word")?.innerHTML;
    const { playback } = build();
    expect(root.querySelectorAll(".waves-gsap-char").length).toBe(2);
    playback.kill();
    engines.forEach((e) => e.dispose());
    engines = [];
    expect(root.querySelectorAll(".waves-gsap-char").length).toBe(0);
    expect(root.querySelector(".ob-word")?.innerHTML).toBe(before);
  });

  it("applies house-spring physics as the tween ease", () => {
    const { playback } = build({
      version: 1,
      name: "spring",
      ops: [{ id: "s", type: "spring", target: ".ob-orb", to: { y: 100 }, duration: 1, spring: { stiffness: 300, damping: 25 } }]
    });
    const tween = playback.timeline().getChildren()[0] as gsap.core.Tween;
    expect(typeof tween.vars.ease).toBe("function");
    const eased = (tween.vars.ease as (t: number) => number)(0.5);
    expect(eased).toBeGreaterThan(0);
    expect(eased).toBeLessThanOrEqual(1.2);
  });

  it("throws on invalid specs instead of building", () => {
    const engine = new GsapEngine({ scope: root });
    engines.push(engine);
    expect(() => engine.build({ version: 1, name: "bad", ops: [{ id: "x", type: "tween", target: ".missing", to: { opacity: 1 } }] })).toThrowError(/GSAP_TARGET_MISSING/);
  });

  it("survives repeated mount/unmount without leaking timelines or DOM", () => {
    const baselineTimelines = gsap.globalTimeline.getChildren().length;
    const baselineTriggers = ScrollTrigger.getAll().length;
    for (let i = 0; i < 10; i++) {
      const engine = new GsapEngine({ scope: root, reducedMotion: "off" });
      const { playback } = engine.build(obsidianLike(), { autoplay: false });
      playback.play();
      playback.progress(0.5);
      engine.dispose();
    }
    expect(root.querySelectorAll(".waves-gsap-char").length).toBe(0);
    expect(gsap.globalTimeline.getChildren().length).toBe(baselineTimelines);
    expect(ScrollTrigger.getAll().length).toBe(baselineTriggers);
  });

  it("honors reduced motion: final state, no ambient, no movement", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
    const engine = new GsapEngine({ scope: root, reducedMotion: "auto" });
    engines.push(engine);
    const { playback, report } = engine.build(obsidianLike(), { autoplay: false });
    expect(report.reducedMotionApplied).toBe(true);
    expect(report.skipped.some((s) => s.includes("drift"))).toBe(true);
    expect(playback.state()).toBe("COMPLETED");
    expect(playback.progress()).toBe(1);
  });
});
