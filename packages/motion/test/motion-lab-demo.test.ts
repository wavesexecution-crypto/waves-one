/**
 * Motion Lab demo reel — contract tests.
 *
 * A product demonstration, so these assert what a screenshot cannot: the master
 * timeline is exactly 12.000s, the five required scene labels exist and land on
 * composed frames, masking is real clipPath ops rather than CSS, every target
 * lives inside the reel stage, and the copy states no pricing or capabilities
 * the product does not have.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planTimeline } from "../src/gsap/plan";
import { validateGsapSpec } from "../src/gsap/validate";
import {
  buildMotionLabDemo,
  MOTION_LAB_DEMO_H,
  MOTION_LAB_DEMO_MS,
  MOTION_LAB_DEMO_NAME,
  MOTION_LAB_DEMO_SCENES,
  MOTION_LAB_DEMO_W
} from "../src/gsap/motion-lab-demo";

const spec = buildMotionLabDemo();
const plan = planTimeline(spec);
const byId = new Map(spec.ops.map((op) => [op.id, op]));
const labels = plan.labels;

const stageSrc = readFileSync("apps/motion-lab/src/MotionLabDemoReel.tsx", "utf8");
const cssSrc = readFileSync("apps/motion-lab/src/motion-lab-demo.css", "utf8");
const cssCode = cssSrc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

describe("motion-lab-demo geometry", () => {
  it("is a 9:16 1080x1920 vertical artboard", () => {
    expect(MOTION_LAB_DEMO_W / MOTION_LAB_DEMO_H).toBeCloseTo(9 / 16, 6);
    expect([MOTION_LAB_DEMO_W, MOTION_LAB_DEMO_H]).toEqual([1080, 1920]);
  });
});

describe("motion-lab-demo spec", () => {
  it("is named and versioned for the GSAP track", () => {
    expect(spec.name).toBe(MOTION_LAB_DEMO_NAME);
    expect(spec.version).toBe(1);
    expect(spec.ops.length).toBeGreaterThan(40);
  });

  it("validates with zero errors and no layout-thrashing props", () => {
    const report = validateGsapSpec(spec);
    expect(report.errors).toEqual([]);
    expect(report.warnings.filter((w) => w.code === "GSAP_LAYOUT_PROP")).toEqual([]);
  });

  it("has unique op ids", () => {
    expect(new Set(spec.ops.map((op) => op.id)).size).toBe(spec.ops.length);
  });
});

describe("motion-lab-demo master timeline", () => {
  it("is exactly 12000ms", () => {
    expect(plan.totalMs).toBe(MOTION_LAB_DEMO_MS);
  });

  it("is finite with no ScrollTrigger ops", () => {
    expect(plan.ambientCount).toBe(0);
    expect(spec.ops.every((op) => op.type !== "scroll")).toBe(true);
    expect(plan.scrubbedCount).toBe(0);
  });

  it("never runs an op past the end of the reel", () => {
    for (const span of plan.spans) {
      expect(span.endMs).toBeLessThanOrEqual(MOTION_LAB_DEMO_MS);
    }
  });

  it("pins the total with the progress rail, a real linear read of the timeline", () => {
    const rail = byId.get("progress-rail")!;
    expect(rail.ease).toBe("none");
    expect(rail.duration).toBe(12);
    expect(rail.to).toEqual({ scaleX: 1 });
  });
});

describe("motion-lab-demo scenes", () => {
  it("declares exactly the five required labels", () => {
    expect(MOTION_LAB_DEMO_SCENES.map((s) => s.label)).toEqual([
      "brief",
      "transition",
      "motion",
      "render",
      "final"
    ]);
  });

  it("labels all five in the published spec, in order, at the declared times", () => {
    const times = MOTION_LAB_DEMO_SCENES.map((s) => labels[s.label]);
    expect(times.every((t) => typeof t === "number")).toBe(true);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeGreaterThan(times[i - 1] as number);
    }
    for (const scene of MOTION_LAB_DEMO_SCENES) {
      expect(labels[scene.label]).toBe(Math.round(scene.at * 1000));
    }
  });

  it("labels land on composed frames, not mid-transition", () => {
    const scrubIds = new Set(spec.ops.filter((op) => op.ease === "none").map((op) => op.id));
    for (const scene of MOTION_LAB_DEMO_SCENES) {
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
});

describe("motion-lab-demo scenes never stack", () => {
  it("hides every finished scene container before the final lockup", () => {
    // Regression guard: the final lockup once played over the top of the
    // still-visible render card. Each scene's shell must be set back to
    // opacity 0 after its label and before the final scene switches on.
    const finalOn = 9.48;
    for (const [container, label] of [
      [".mld-s-brief", "brief"],
      [".mld-s-transition", "transition"],
      [".mld-s-motion", "motion"],
      [".mld-s-render", "render"]
    ] as const) {
      const off = spec.ops.find(
        (op) =>
          op.type === "set" &&
          op.target === container &&
          (op.to as Record<string, unknown>)?.opacity === 0 &&
          typeof op.position === "number" &&
          Math.round(op.position * 1000) > labels[label] &&
          op.position < finalOn
      );
      expect({ container, off: Boolean(off) }).toEqual({ container, off: true });
    }
  });
});

describe("motion-lab-demo required motion", () => {
  it("staggers the four real site captures with clipPath masks", () => {
    const reveal = byId.get("mot-shots-in")!;
    expect(reveal.type).toBe("stagger");
    expect(reveal.target).toBe(".mld-shot");
    expect(reveal.from?.clipPath).toBe("inset(100% 0% 0% 0%)");
    expect(reveal.to?.clipPath).toBe("inset(0% 0% 0% 0%)");
    expect(spec.ops.filter((op) => /^mot-shot-set-\d$/.test(op.id)).length).toBe(4);
  });

  it("only uses GSAP core easings", () => {
    for (const op of spec.ops) {
      if (!op.ease) continue;
      expect(op.ease).toMatch(/^(none|power[0-4]|back|elastic|bounce|circ|expo|sine|linear)(\.(in|out|inOut))?(\([\d.,\s]*\))?$/);
    }
  });

  it("keeps every op inside the reel stage", () => {
    for (const op of spec.ops) {
      expect(op.target.startsWith(".mld-") || op.target.startsWith("[data-")).toBe(true);
    }
  });
});

describe("motion-lab-demo is an honest product demo", () => {
  it("shows the real MCP tool call and spec shape, not a fake terminal", () => {
    expect(stageSrc).toContain("create_gsap_animation");
    expect(stageSrc).toContain(`"name": "SEAI launch reel"`);
  });

  it("renders the real SEAI demo captures, not redrawn sites", () => {
    for (const vertical of ["restaurant", "gym", "salon", "cafe"]) {
      expect(stageSrc).toContain(`/assets/seai-demos/${vertical}-hero.png`);
    }
  });

  it("states real export parameters and invents no capabilities", () => {
    const copy = stageSrc
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/[{}[\]"'`,;]/g, " ")
      .replace(/\s+/g, " ");
    for (const line of ["BRIEF", "MOTION", "1080", "1920", "60 FPS", "H.264", "WAVES MOTION LAB", "motion.wavesco.in"]) {
      expect(copy).toContain(line);
    }
    expect(copy).not.toMatch(/[$£€]\s?\d/);
    expect(copy).not.toMatch(/\d+\s?%/);
    expect(copy.toLowerCase()).not.toMatch(/guarantee|\bbest\b|#1|trusted by|\bclients\b/);
  });

  it("adds no glow, particles, or decorative motion", () => {
    expect(cssCode).not.toMatch(/backdrop-filter|blur\(|text-shadow/);
    expect(cssCode).not.toMatch(/@keyframes|animation:|will-change|transition:/);
  });
});
