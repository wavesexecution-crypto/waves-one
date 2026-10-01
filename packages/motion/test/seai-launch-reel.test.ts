/**
 * SEAI launch reel — contract tests.
 *
 * The reel is choreography, so these assert what a screenshot cannot: that the
 * master timeline is exactly 15.000s, that the five required scene labels exist
 * and land on composed frames, that masking/parallax are real ops rather than
 * CSS, that the visuals are the REAL SEAI project rather than invented
 * approximations, and that nothing ambient or scroll-scrubbed sneaks in and
 * breaks "completes, holds, reverses".
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planTimeline } from "../src/gsap/plan";
import { validateGsapSpec } from "../src/gsap/validate";
import {
  buildSeaiLaunchReel,
  SEAI_REEL_DEMOS,
  SEAI_REEL_H,
  SEAI_REEL_MS,
  SEAI_REEL_NAME,
  SEAI_REEL_SCENES,
  SEAI_REEL_W
} from "../src/gsap/seai-launch-reel";

const spec = buildSeaiLaunchReel();
const plan = planTimeline(spec);
const byId = new Map(spec.ops.map((op) => [op.id, op]));
const labels = plan.labels;

const stageSrc = readFileSync("apps/motion-lab/src/SeaiLaunchReel.tsx", "utf8");
const cssSrc = readFileSync("apps/motion-lab/src/seai-reel.css", "utf8");
/** Strip comments so prose about a rule never trips the rule itself. */
const cssCode = cssSrc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

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
    expect(spec.ops.length).toBeGreaterThan(50);
  });

  it("validates with zero errors", () => {
    expect(validateGsapSpec(spec).errors).toEqual([]);
  });

  it("uses no layout-triggering properties", () => {
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

  it("opens on the mark and closes on the lockup", () => {
    expect(byId.get("intro-logo-in")?.position).toBe(0.1);
    // The CTA is the last content op, and the rail is what lands on 15000.
    const cta = plan.spans.find((s) => s.id === "final-cta-in")!;
    expect(cta.endMs).toBeLessThan(SEAI_REEL_MS);
    expect(byId.get("final-cta-in")?.ease).toBe("back.out(1.5)");
  });

  it("pins the total with the progress rail, a real linear read of the timeline", () => {
    const rail = byId.get("progress-rail")!;
    expect(rail.ease).toBe("none");
    expect(rail.duration).toBe(15);
    expect(rail.to).toEqual({ scaleX: 1 });
  });
});

describe("seai-launch-reel scenes", () => {
  it("declares exactly the five required labels", () => {
    expect(SEAI_REEL_SCENES.map((s) => s.label)).toEqual([
      "intro",
      "ai-build",
      "showcase",
      "capabilities",
      "final"
    ]);
  });

  it("labels all five in the published spec, in order", () => {
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
    // A reduced-motion step seeks to a label. Only the structural scrubs (the
    // rail and its linear drifts) may still be in flight there.
    const scrubIds = new Set(spec.ops.filter((op) => op.ease === "none").map((op) => op.id));
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
    const earliest: Record<string, number> = {
      intro: 0,
      "ai-build": 2000,
      showcase: 4000,
      capabilities: 7000,
      final: 10000
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
    expect(textOps.length).toBeGreaterThanOrEqual(14);
    for (const op of textOps) {
      expect(op.split === "chars" || op.split === "words").toBe(true);
      expect(typeof op.stagger).toBe("number");
    }
  });

  it("staggers the seven real site captures", () => {
    const reveal = byId.get("show-in")!;
    expect(reveal.type).toBe("stagger");
    expect(reveal.type === "stagger" && reveal.stagger).toEqual({ each: 0.1, from: "first" });
    expect(reveal.target).toBe(".sr-shot");
    // Seven, matching SEAI's seven shipped verticals.
    expect(SEAI_REEL_DEMOS.length).toBe(7);
    expect(spec.ops.filter((op) => /^show-drift-\d$/.test(op.id)).length).toBe(7);
    expect(spec.ops.filter((op) => /^show-set-\d$/.test(op.id)).length).toBe(7);
  });

  it("masks the site captures with clipPath rather than a fade", () => {
    const reveal = byId.get("show-in")!;
    expect(reveal.from?.clipPath).toBe("inset(100% 0% 0% 0%)");
    expect(reveal.to?.clipPath).toBe("inset(0% 0% 0% 0%)");
    // The finished site in the final scene is masked too.
    expect(byId.get("final-plate-in")?.from?.clipPath).toBe("inset(100% 0% 0% 0%)");
  });

  it("drives parallax from layered linear drifts, not ScrollTrigger", () => {
    const conveyor = byId.get("show-conveyor")!;
    expect(conveyor.ease).toBe("none");
    expect(conveyor.to).toEqual({ y: -1720 });
    // Seven counter-drifts at seven different rates is the depth.
    const drifts = SEAI_REEL_DEMOS.map((_, i) => Number(byId.get(`show-drift-${i + 1}`)!.to?.x));
    expect(new Set(drifts).size).toBe(7);
    expect(byId.get("final-depth-1")?.ease).toBe("none");
    expect(byId.get("final-depth-2")?.ease).toBe("none");
  });

  it("collapses the four pillars into one point, not just a scale-down", () => {
    const pulls = [1, 2, 3, 4].map((i) => Number(byId.get(`caps-pull-${i}`)?.to?.y));
    expect(pulls[0]).toBeGreaterThan(0);
    expect(pulls[1]).toBeGreaterThan(0);
    expect(pulls[2]).toBeLessThan(0);
    expect(pulls[3]).toBeLessThan(0);
    // Outermost travel furthest, so they meet rather than cross.
    expect(Math.abs(pulls[3])).toBeGreaterThan(Math.abs(pulls[2]));
    const collapse = byId.get("caps-collapse")!;
    expect(collapse.type === "stagger" && collapse.stagger).toEqual({ each: 0.035, from: "center" });
    expect(collapse.to?.scale).toBe(0.14);
  });

  it("only uses GSAP core easings", () => {
    for (const op of spec.ops) {
      if (!op.ease) continue;
      expect(op.ease).toMatch(/^(none|power[0-4]|back|elastic|bounce|circ|expo|sine|linear)(\.(in|out|inOut))?(\([\d.,\s]*\))?$/);
    }
  });

  it("keeps every op inside the reel stage", () => {
    for (const op of spec.ops) {
      expect(op.target.startsWith(".sr-") || op.target.startsWith("[data-")).toBe(true);
    }
  });
});

describe("seai-launch-reel uses the REAL SEAI project", () => {
  it("renders all seven SEAI demo verticals from captured pages", () => {
    // Captured as `${demo.key}-hero.png` from the DEMOS table, so assert the
    // table drives it and the capture path is the real one.
    expect(stageSrc).toContain("/assets/seai-demos/${demo.key}-hero.png");
    for (const vertical of SEAI_REEL_DEMOS) {
      expect(stageSrc).toContain(`{ key: "${vertical}"`);
    }
  });

  it("references no invented business names or hand-drawn site cards", () => {
    // The previous build drew fake sites (Forno, Ironworks, Lumen, North & Key)
    // and hand-built browser chrome. The reel must show SEAI's own builds.
    for (const invented of ["Forno", "Ironworks", "Lumen", "NORTH & KEY", "sr-card", "sr-browser", "sr-dot"]) {
      expect(stageSrc).not.toContain(invented);
    }
    // Captures are local assets, not a hotlink to a live site.
    expect(stageSrc).not.toMatch(/https?:\/\//);
  });

  it("uses SEAI's own typefaces and brand marks", () => {
    for (const asset of [
      "inter-latin-normal",
      "instrument-serif-latin-normal",
      "instrument-serif-latin-italic",
      "jetbrains-mono-latin-normal"
    ]) {
      expect(cssCode).toContain(`/assets/seai-brand/${asset}.woff2`);
    }
    expect(stageSrc).toContain("/assets/seai-brand/logo.svg");
  });

  it("inherits SEAI's design tokens rather than approximating them", () => {
    for (const token of [
      "--seai-ink: #0b0b0c",
      "--seai-paper: #fbfbfa",
      "--seai-sub: #56565e",
      "--seai-faint: #8e8e96",
      "--seai-radius: 3px",
      "--seai-ease: cubic-bezier(0.16, 1, 0.3, 1)"
    ]) {
      expect(cssCode).toContain(token);
    }
  });

  it("adds none of the effects SEAI's own system rules out", () => {
    // "Expensive through type, scale, spacing, material and precision - never
    // through gradients, glow, glassmorphism, heavy radii or decorative motion."
    expect(cssCode).not.toMatch(/backdrop-filter|blur\(|text-shadow/);
    expect(cssCode).not.toMatch(/@keyframes|animation:|will-change|transition:/);
    // Gradients are allowed ONLY as photographic falloff, never as decoration.
    // Exactly three exist, each with a job: the stage vignette, the caption
    // scrim over a site capture, and the top scrim on the finished-site plate.
    expect((cssCode.match(/gradient\(/g) ?? []).length).toBe(3);
    for (const selector of [".sr-vignette", ".sr-shot-cap", ".sr-plate-depth"]) {
      expect(cssCode).toContain(selector);
    }
  });

  it("never puts white overlay copy on the light site plate", () => {
    // Regression guard. `.sr-plate` is a captured (light) page and `.sr-built`
    // is white type; a full-bleed plate rendered the line invisible before.
    const plateTop = Number(/^\.sr-plate \{[\s\S]*?top:\s*(\d+)px;/m.exec(cssCode)?.[1]);
    const plateHeight = Number(/^\.sr-plate \{[\s\S]*?height:\s*(\d+)px;/m.exec(cssCode)?.[1]);
    const builtBottom = Number(/^\.sr-built \{[\s\S]*?bottom:\s*(\d+)px;/m.exec(cssCode)?.[1]);
    expect(Number.isNaN(plateTop) || Number.isNaN(plateHeight) || Number.isNaN(builtBottom)).toBe(false);
    // Two 82px lines plus tracking, generously boxed.
    const builtTop = SEAI_REEL_H - builtBottom - 260;
    expect(builtTop).toBeGreaterThan(plateTop + plateHeight);
  });

  it("carries the reel's own script and no invented claims", () => {
    const copy = stageSrc
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/[{}[\]"'`,;]/g, " ")
      .replace(/\s+/g, " ");
    for (const line of [
      "YOUR BUSINESS",
      "NEEDS A WEBSITE.",
      "WE BUILD IT.",
      "DESIGN.",
      "CODE.",
      "CONTENT.",
      "SEO.",
      "ONE WEBSITE.",
      "BUILT FOR",
      "AI-BUILT WEBSITES.",
      "BUILD YOURS"
    ]) {
      expect(copy).toContain(line);
    }
    expect(copy).not.toMatch(/[$£€]\s?\d/);
    expect(copy).not.toMatch(/\d+\s?%/);
    expect(copy.toLowerCase()).not.toMatch(/rating|review|trusted by|\bclients\b|customers|guarantee|\bbest\b|#1/);
  });
});