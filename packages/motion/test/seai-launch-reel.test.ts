/**
 * SEAI launch reel — contract tests.
 *
 * The reel is choreography, so these assert the things a screenshot cannot:
 * that the master timeline is exactly 15.000s, that every scene carries a label
 * landing on a composed frame, that the mask/parallax primitives the brief asked
 * for are real ops rather than CSS, and that nothing ambient or scroll-scrubbed
 * sneaks in and breaks "completes, holds, reverses".
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planTimeline } from "../src/gsap/plan";
import { validateGsapSpec } from "../src/gsap/validate";
import { buildSeaiLaunchReel, SEAI_REEL_MS, SEAI_REEL_NAME, SEAI_REEL_SCENES, SEAI_REEL_H, SEAI_REEL_W } from "../src/gsap/seai-launch-reel";

const spec = buildSeaiLaunchReel();
const plan = planTimeline(spec);
const byId = new Map(spec.ops.map((op) => [op.id, op]));
const labels = plan.labels;

describe("seai-launch-reel geometry", () => {
  it("is a 9:16 1080x1920 vertical artboard", () => {
    expect(SEAI_REEL_W / SEAI_REEL_H).toBeCloseTo(9 / 16, 6);
    expect([SEAI_REEL_W, SEAI_REEL_H]).toEqual([1080, 1920]);
  });
});

describe("seai-launch-reel spec", () => {
  it("is named and versioned for the GSAP track", () => {
    expect(spec.name).toBe(SEAI_REEL_NAME);
    expect(spec.version).toBe(1);
    expect(spec.ops.length).toBeGreaterThan(40);
  });

  it("validates with zero errors", () => {
    const report = validateGsapSpec(spec);
    expect(report.errors).toEqual([]);
  });

  it("uses no layout-triggering properties", () => {
    // width/height/top/left/fontSize would relayout every frame of a reel.
    const report = validateGsapSpec(spec);
    expect(report.warnings.filter((w) => w.code === "GSAP_LAYOUT_PROP")).toEqual([]);
  });

  it("has unique op ids", () => {
    expect(new Set(spec.ops.map((op) => op.id)).size).toBe(spec.ops.length);
  });
});

describe("seai-launch-reel master timeline", () => {
  it("is exactly 15000ms", () => {
    expect(plan.totalMs).toBe(SEAI_REEL_MS);
  });

  it("is finite: no ambient loops", () => {
    expect(plan.ambientCount).toBe(0);
    expect(spec.ops.every((op) => op.ambient !== true)).toBe(true);
  });

  it("has no ScrollTrigger ops, so timing is reproducible in a paused timeline", () => {
    expect(spec.ops.every((op) => op.type !== "scroll")).toBe(true);
    expect(plan.scrubbedCount).toBe(0);
  });

  it("never runs an op past the end of the reel", () => {
    for (const span of plan.spans) {
      expect(span.endMs).toBeLessThanOrEqual(SEAI_REEL_MS);
    }
  });

  it("opens on a black frame and closes on the lockup", () => {
    // The hook's first op is a set, so nothing is visible before the slam.
    expect(byId.get("s1-on")?.position).toBe(0);
    expect(labels["01 HOOK"]).toBeGreaterThan(0);
    // The CTA is the last piece of content, well before the rail lands.
    const cta = byId.get("s6-cta-in")!;
    expect(plan.spans.find((s) => s.id === "s6-cta-in")!.endMs).toBeLessThan(SEAI_REEL_MS);
    expect(cta.ease).toBe("back.out(1.6)");
  });

  it("pins the total with the progress rail, a real linear read of the timeline", () => {
    const rail = byId.get("progress-rail")!;
    expect(rail.ease).toBe("none");
    expect(rail.duration).toBe(15);
    expect(rail.to).toEqual({ scaleX: 1 });
  });
});

describe("seai-launch-reel scenes", () => {
  it("labels all six scenes in order", () => {
    const times = SEAI_REEL_SCENES.map((s) => labels[s.label]);
    expect(times.every((t) => typeof t === "number")).toBe(true);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeGreaterThan(times[i - 1] as number);
    }
  });

  it("declares label times that match the published spec exactly", () => {
    for (const scene of SEAI_REEL_SCENES) {
      expect(labels[scene.label]).toBe(Math.round(scene.at * 1000));
    }
  });

  it("labels land on composed frames, not mid-transition", () => {
    // A reduced-motion step seeks to a label. If a label sat in the middle of a
    // tween, the viewer would land on a half-played slam. At each label, the
    // only ops allowed to still be in flight are the structural scrubs — the
    // progress rail and the linear parallax drifts, which are by definition
    // never "finished".
    const scrubIds = new Set(
      spec.ops.filter((op) => op.ease === "none").map((op) => op.id)
    );
    for (const scene of SEAI_REEL_SCENES) {
      const at = labels[scene.label];
      const inFlight = plan.spans.filter((s) => s.startMs <= at && s.endMs > at && s.type !== "set");
      for (const span of inFlight) {
        expect({ label: scene.label, op: span.id, scrub: scrubIds.has(span.id) }).toEqual({
          label: scene.label,
          op: span.id,
          scrub: true
        });
      }
    }
  });

  it("keeps each scene inside the brief's timebox", () => {
    // 01 hook 0–2, 02 claim 2–4, 03 work 4–7, 04 system 7–10, 05 result 10–12.5,
    // 06 lockup 12.5–15. Scene content must not start before its box.
    const earliest: Record<string, number> = {
      "01 HOOK": 0,
      "02 CLAIM": 2000,
      "03 WORK": 4000,
      "04 SYSTEM": 7000,
      "05 RESULT": 10000,
      "06 LOCKUP": 12500
    };
    for (const scene of SEAI_REEL_SCENES) {
      const op = spec.ops.find((o) => o.label === scene.label)!;
      const startMs = typeof op.position === "number" ? Math.round(op.position * 1000) : -1;
      expect(startMs).toBeGreaterThanOrEqual(earliest[scene.label]);
    }
  });
});

describe("seai-launch-reel required motion", () => {
  it("uses a text reveal for every headline", () => {
    const textOps = spec.ops.filter((op) => op.type === "text");
    expect(textOps.length).toBeGreaterThanOrEqual(10);
    for (const op of textOps) {
      expect(op.split === "chars" || op.split === "words").toBe(true);
      expect(typeof op.stagger).toBe("number");
    }
  });

  it("staggers the four website cards", () => {
    const cards = byId.get("s3-cards-in")!;
    expect(cards.type).toBe("stagger");
    expect(cards.type === "stagger" && cards.stagger).toEqual({ each: 0.13, from: "first" });
    expect(cards.target).toBe(".sr-card");
  });

  it("masks the site cards with clipPath rather than a fade", () => {
    const reveal = byId.get("s3-cards-in")!;
    expect(reveal.from?.clipPath).toBe("inset(100% 0% 0% 0%)");
    expect(reveal.to?.clipPath).toBe("inset(0% 0% 0% 0%)");
    // The five scene reveal must mask too.
    expect(byId.get("s5-site-in")?.from?.clipPath).toBe("inset(100% 0% 0% 0%)");
  });

  it("drives parallax from layered linear drifts, not ScrollTrigger", () => {
    const conveyor = byId.get("s3-conveyor")!;
    expect(conveyor.ease).toBe("none");
    expect(conveyor.to).toEqual({ y: -1560 });
    // Four counter-drifts at four different rates is the depth.
    const drifts = [1, 2, 3, 4].map((i) => byId.get(`s3-drift-${i}`)!);
    expect(drifts.every((d) => d.ease === "none" && d.duration === 2.3)).toBe(true);
    const amounts = drifts.map((d) => Number(d.to?.x));
    expect(new Set(amounts).size).toBe(4);
    // And inside the result scene, four depth layers on mixed axes.
    const depths = [1, 2, 3, 4].map((i) => byId.get(`s5-depth-${i}`)!);
    expect(depths.every((d) => d.ease === "none" && d.duration === 2.3)).toBe(true);
  });

  it("collapses the four pillars into one point, not just a scale-down", () => {
    const pulls = [1, 2, 3, 4].map((i) => Number(byId.get(`s4-pull-${i}`)?.to?.y));
    // Every pillar is pulled toward the centre line.
    expect(pulls[0]).toBeGreaterThan(0);
    expect(pulls[1]).toBeGreaterThan(0);
    expect(pulls[2]).toBeLessThan(0);
    expect(pulls[3]).toBeLessThan(0);
    // Innermost pull the least, so they meet rather than cross.
    expect(Math.abs(pulls[3])).toBeGreaterThan(Math.abs(pulls[2]));
    const collapse = byId.get("s4-collapse")!;
    expect(collapse.type === "stagger" && collapse.stagger).toEqual({ each: 0.035, from: "center" });
    expect(collapse.to?.scale).toBe(0.14);
  });

  it("only uses GSAP core easings", () => {
    for (const op of spec.ops) {
      if (!op.ease) continue;
      expect(op.ease).toMatch(/^(none|power[0-4]|back|elastic|bounce|circ|expo|sine|linear)(\.(in|out|inOut))?(\([\d.,\s]*\))?$/);
    }
  });

  it("keeps every op inside the artboard's own scene shell", () => {
    // No op may target a node outside the reel stage.
    for (const op of spec.ops) {
      expect(op.target.startsWith(".sr-") || op.target.startsWith("[data-")).toBe(true);
    }
  });
});

describe("seai-launch-reel copy", () => {
  // The spec holds selectors, not prose, so a claim guard has to read the stage
  // markup where the visible strings actually live. This is the assertion that
  // keeps the reel publishable: SEAI's positioning is safe to show, invented
  // proof points and pricing are not.
  const stage = readFileSync("apps/motion-lab/src/SeaiLaunchReel.tsx", "utf8");
  /** Visible copy only: strip JSX/TS syntax and comments. */
  const copy = stage
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[{}[\]"'`,;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  it("carries the required brand lines", () => {
    for (const line of ["YOUR BUSINESS", "NEEDS A WEBSITE.", "WE BUILD IT.", "WITH AI.", "DESIGN.", "CODE.", "CONTENT.", "SEO.", "ONE WEBSITE.", "BUILT FOR", "YOUR BUSINESS.", "SEAI", "AI-BUILT WEBSITES.", "BUILD YOURS"]) {
      expect(copy).toContain(line);
    }
  });

  it("states no pricing", () => {
    expect(copy).not.toMatch(/[$£€]\s?\d/);
    expect(copy.toLowerCase()).not.toMatch(/per month|\/mo\b|monthly|starting at|from just/);
  });

  it("claims no metrics or social proof", () => {
    expect(copy).not.toMatch(/\d+\s?%/);
    expect(copy.toLowerCase()).not.toMatch(/rating|review|trusted by|clients|customers|\b\d+\+?\s?(businesses|clients|websites built)/);
  });

  it("invents no superlatives about SEAI's service", () => {
    expect(copy.toLowerCase()).not.toMatch(/best|#1|fastest|guarantee|unmatched|world-class/);
  });

  it("keeps the four brief verticals", () => {
    for (const vertical of ['data-site="restaurant"', 'data-site="gym"', 'data-site="salon"', 'data-site="estate"']) {
      expect(stage).toContain(vertical);
    }
  });

  it("never puts white overlay copy on the white site panel", () => {
    // Regression guard. `.sr-site` is a #fafafa page and `.sr-built` is white
    // type; a full-bleed panel rendered "BUILT FOR / YOUR BUSINESS." invisible.
    // The panel is pinned to the top of the artboard and the line lives in the
    // black band beneath it, so assert the two authored boxes cannot overlap.
    const css = readFileSync("apps/motion-lab/src/seai-reel.css", "utf8");
    const siteTop = Number(/^\.sr-site \{[\s\S]*?top:\s*(\d+)px;/m.exec(css)?.[1]);
    const siteHeight = Number(/^\.sr-site \{[\s\S]*?height:\s*(\d+)px;/m.exec(css)?.[1]);
    const builtBottom = Number(/^\.sr-built \{[\s\S]*?bottom:\s*(\d+)px;/m.exec(css)?.[1]);
    expect(Number.isNaN(siteTop) || Number.isNaN(siteHeight) || Number.isNaN(builtBottom)).toBe(false);
    // The copy needs two 84px lines plus tracking; allow a generous box.
    const builtTop = SEAI_REEL_H - builtBottom - 260;
    expect(builtTop).toBeGreaterThan(siteTop + siteHeight);
  });
});
