import { describe, expect, it } from "vitest";
import { createEngine } from "../src";
import { createAnimation } from "../src/animation";
import { resolveSpec } from "../src/animation/resolve";
import { createManualClock } from "../src/core/clock";

function frame(engine: ReturnType<typeof createEngine>, step: number): void {
  const clock = engine.clock as unknown as { frame(step: number): number };
  clock.frame(step);
}
function makeElement(): HTMLElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
}

describe("spec resolution", () => {
  it("resolves authored property forms into a deterministic spec", () => {
    const engine = createEngine({ name: "resolve-test", manual: true, clock: createManualClock() });
    const resolved = resolveSpec("#x", { y: [24, 0] }, { duration: 300, delay: 50 }, engine);
    expect(resolved.spec.delay).toBe(50);
    expect(resolved.spec.duration).toBe(300);
    expect(resolved.totalDuration).toBe(350);
    expect(resolved.spec.properties.y).toEqual({ from: 24, to: 0 });
    expect(resolved.spec.cost.y).toBe("composite");
  });

  it("degrades transform travel under reduced motion but keeps the landing state", () => {
    const engine = createEngine({
      name: "resolve-reduced",
      manual: true,
      clock: createManualClock(),
      config: { reducedMotion: "force" }
    });
    const resolved = resolveSpec("#x", { y: [24, 0], opacity: [0, 1] }, {}, engine);
    expect(resolved.reduced).toBe(true);
    expect(resolved.spec.properties.y).toEqual({ from: 0, to: 0 });
    expect(resolved.spec.properties.opacity).toEqual({ from: 0, to: 1 });
  });

  it("reports unknown properties as diagnostics instead of throwing", () => {
    const engine = createEngine({ name: "resolve-unknown", manual: true, clock: createManualClock() });
    const resolved = resolveSpec("#x", { notARealProperty: 1 } as never, {}, engine);
    expect(resolved.spec.properties.notARealProperty).toBeUndefined();
  });
});

describe("animation runtime", () => {
  it("writes real styles over time and lands on the final value", () => {
    const engine = createEngine({ name: "anim-runtime", manual: true, clock: createManualClock() });
    const element = makeElement();
    const resolved = resolveSpec(element, { y: [24, 0], opacity: [0, 1] }, { duration: 200 }, engine);
    const animation = createAnimation(resolved, engine);
    engine.registry.register(animation);

    animation.play();
    frame(engine, 16); // first frame applies the captured start state
    frame(engine, 16);
    const midTransform = element.style.transform;
    expect(midTransform).toContain("translate3d");
    const midY = parseFloat(midTransform.match(/translate3d\([^,]+,\s*(-?[\d.]+)px/)?.[1] ?? "24");
    expect(midY).toBeLessThan(24);
    expect(midY).toBeGreaterThan(0);
    expect(parseFloat(element.style.opacity)).toBeGreaterThan(0);
    expect(parseFloat(element.style.opacity)).toBeLessThan(1);

    frame(engine, 190);
    expect(element.style.opacity).toBe("1");
    expect(element.style.transform).toContain("translate3d(0px, 0px, 0px)");
    expect(animation.progress).toBe(1);
    expect(animation.state).toBe("finished");
    engine.reset();
  });

  it("pauses and resumes without losing elapsed time", () => {
    const engine = createEngine({ name: "anim-pause", manual: true, clock: createManualClock() });
    const element = makeElement();
    const resolved = resolveSpec(element, { opacity: [0, 1] }, { duration: 100 }, engine);
    const animation = createAnimation(resolved, engine);
    engine.registry.register(animation);
    animation.play();

    frame(engine, 50);
    const atPause = element.style.opacity;
    animation.pause();
    frame(engine, 50);
    expect(element.style.opacity).toBe(atPause);
    animation.resume();
    frame(engine, 50);
    expect(parseFloat(element.style.opacity)).toBeGreaterThan(parseFloat(atPause));
    engine.reset();
  });

  it("seeks to 50% progress and paints immediately", () => {
    const engine = createEngine({ name: "anim-seek", manual: true, clock: createManualClock() });
    const element = makeElement();
    const resolved = resolveSpec(element, { opacity: [0, 1] }, { duration: 100 }, engine);
    const animation = createAnimation(resolved, engine);
    animation.seekTo(0.5);
    expect(parseFloat(element.style.opacity)).toBeCloseTo(0.5, 1);
    engine.reset();
  });
});
