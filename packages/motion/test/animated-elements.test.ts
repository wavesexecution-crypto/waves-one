import { describe, expect, it } from "vitest";
import { createEngine } from "../src";
import { createManualClock } from "../src/core/clock";
import { createScroll } from "../src/scroll";

function frame(engine: ReturnType<typeof createEngine>, step: number): void {
  const clock = engine.clock as unknown as { frame(step: number): number };
  clock.frame(step);
}
function makeElement(): HTMLElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
}
function parse3d(transform: string, index: number): number {
  const match = transform.match(/translate3d\(([-0-9.e]*)px,\s*([-0-9.e]*)px,\s*([-0-9.e]*)px\)/);
  if (!match) return NaN;
  return parseFloat(match[index + 1]);
}
function xOf(element: HTMLElement): string {
  const match = element.style.transform.match(/translate3d\(([-0-9.e]*)px,/)
  return match ? match[1] : "";
}

describe("animated elements", () => {
  it("moves an element along x and y over its duration", () => {
    const engine = createEngine({ name: "ae-xy", manual: true, clock: createManualClock() });
    const element = makeElement();
    const handle = engine.animate(element, { x: [0, 200], y: [0, 100] }, { duration: 200 });

    frame(engine, 16); // first frame applies the captured start state
    frame(engine, 320); // run straight past the active span

    expect(element.style.transform).toBe("translate3d(200px, 100px, 0px)");
    expect(handle.state).toBe("finished");
    engine.reset();
  });

  it("writes negative translate values", () => {
    const engine = createEngine({ name: "ae-negative", manual: true, clock: createManualClock() });
    const element = makeElement();
    engine.animate(element, { x: [0, -120] }, { duration: 200 });

    frame(engine, 16);
    frame(engine, 320);

    expect(element.style.transform).toBe("translate3d(-120px, 0px, 0px)");
    engine.reset();
  });

  it("composes several transform channels into a single transform string", () => {
    const engine = createEngine({ name: "ae-compose", manual: true, clock: createManualClock() });
    const element = makeElement();
    engine.animate(element, { x: [0, 120], rotate: 45, scale: [0.5, 1] }, { duration: 200 });

    frame(engine, 16);
    frame(engine, 320);

    expect(element.style.transform).toBe("translate3d(120px, 0px, 0px) rotate(45deg) scale(1, 1)");
    engine.reset();
  });

  it("animates opacity to its target", () => {
    const engine = createEngine({ name: "ae-opacity", manual: true, clock: createManualClock() });
    const element = makeElement();
    engine.animate(element, { opacity: [0, 1] }, { duration: 200 });

    frame(engine, 16);
    frame(engine, 320);

    expect(element.style.opacity).toBe("1");
    engine.reset();
  });

  it("keeps independent elements on their own paths", () => {
    const engine = createEngine({ name: "ae-independence", manual: true, clock: createManualClock() });
    const first = makeElement();
    const second = makeElement();
    engine.animate(first, { x: [0, 100] }, { duration: 200 });
    engine.animate(second, { x: [0, 300] }, { duration: 200 });

    frame(engine, 16);
    frame(engine, 320);

    expect(first.style.transform).toBe("translate3d(100px, 0px, 0px)");
    expect(second.style.transform).toBe("translate3d(300px, 0px, 0px)");
    engine.reset();
  });

  it("respects a delay before starting to move", () => {
    const engine = createEngine({ name: "ae-delay", manual: true, clock: createManualClock() });
    const element = makeElement();
    const handle = engine.animate(element, { x: [0, 200] }, { duration: 200, delay: 100 });

    frame(engine, 16); // paint start state
    frame(engine, 50); // still inside the 100ms delay
    expect(xOf(element)).toBe("0");

    frame(engine, 100); // 50ms past the delay → halfway to the target on linear
    expect(parseFloat(xOf(element))).toBe(50);

    frame(engine, 200); // well past the total duration → finished
    expect(element.style.transform).toBe("translate3d(200px, 0px, 0px)");
    expect(handle.state).toBe("finished");
    engine.reset();
  });

  it("applies a non-linear easing curve at the midpoint", () => {
    const engine = createEngine({ name: "ae-easing", manual: true, clock: createManualClock() });
    const element = makeElement();
    engine.animate(element, { x: [0, 200] }, { duration: 200, easing: "ease-out" });

    frame(engine, 16);
    frame(engine, 50);
    frame(engine, 50); // elapsed 100ms = 50% of the duration

    const mid = parseFloat(xOf(element));
    expect(mid).toBeGreaterThan(120); // ease-out has travelled more than half by mid-time
    expect(mid).toBeLessThan(200);

    frame(engine, 200);
    expect(element.style.transform).toBe("translate3d(200px, 0px, 0px)");
    engine.reset();
  });

  it("rolls a spring through the solver and lands on the target", () => {
    const engine = createEngine({ name: "ae-spring", manual: true, clock: createManualClock() });
    const element = makeElement();
    const handle = engine.animate(element, { x: [0, 150] }, { spring: { stiffness: 200, damping: 24 } });

    frame(engine, 16);
    let guard = 0;
    while (handle.state !== "finished" && guard < 500) {
      frame(engine, 16);
      guard += 1;
    }

    expect(handle.state).toBe("finished");
    expect(element.style.transform).toBe("translate3d(150px, 0px, 0px)");
    engine.reset();
  });

  it("finish() commits the final state immediately", () => {
    const engine = createEngine({ name: "ae-finish", manual: true, clock: createManualClock() });
    const element = makeElement();
    const handle = engine.animate(element, { x: [0, 50], opacity: [0, 1] }, { duration: 20000 });

    frame(engine, 16);
    handle.finish();

    expect(element.style.transform).toBe("translate3d(50px, 0px, 0px)");
    expect(element.style.opacity).toBe("1");
    expect(handle.state).toBe("finished");
    engine.reset();
  });

  it("cancel() freezes the element at the interrupted state", () => {
    const engine = createEngine({ name: "ae-cancel", manual: true, clock: createManualClock() });
    const element = makeElement();
    const handle = engine.animate(element, { x: [0, 200] }, { duration: 2000 });

    frame(engine, 16);
    frame(engine, 200);
    const frozen = xOf(element);
    expect(parseFloat(frozen)).toBeCloseTo(20, 0);

    handle.cancel();
    frame(engine, 100);
    frame(engine, 100);

    expect(xOf(element)).toBe(frozen);
    expect(handle.state).toBe("cancelled");
    engine.reset();
  });

  it("emits a completion event and resolves the finished promise", async () => {
    const engine = createEngine({ name: "ae-complete", manual: true, clock: createManualClock() });
    const element = makeElement();
    const handle = engine.animate(element, { x: [0, 100] }, { duration: 200 });
    let completes = 0;
    handle.on("complete", () => completes += 1);

    frame(engine, 16);
    frame(engine, 320);

    expect(completes).toBe(1);
    await expect(handle.finished).resolves.toMatchObject({ state: "finished" });
    engine.reset();
  });

  it("staggers elements so each starts on its own timeline", () => {
    const engine = createEngine({ name: "ae-stagger", manual: true, clock: createManualClock() });
    const first = makeElement();
    const second = makeElement();
    engine.animate([first, second], { x: [0, 100] }, { duration: 200, stagger: 50 });

    frame(engine, 16); // paint start state
    frame(engine, 50); // elapsed 50ms: first is moving, second still at its start

    expect(parseFloat(xOf(first))).toBeGreaterThan(0);
    expect(xOf(second)).toBe("0");

    frame(engine, 250);
    expect(first.style.transform).toBe("translate3d(100px, 0px, 0px)");
    expect(second.style.transform).toBe("translate3d(100px, 0px, 0px)");
    engine.reset();
  });
});

describe("animated elements — regression coverage", () => {
  it("never escapes the viewport window when scrubbed past the exit", () => {
    const engine = createEngine({ name: "ae-scroll-escape", manual: true, clock: createManualClock() });
    const element = makeElement();
    const controller = createScroll(engine, element, { y: [0, -40] }, { start: 0, end: 2000 });

    controller.evaluate({ scrollY: -999 });
    expect(element.style.transform).toBe("translate3d(0px, 0px, 0px)");
    expect(controller.progressAt(-999)).toBe(0);

    controller.evaluate({ scrollY: 1000 });
    const mid = parse3d(element.style.transform, 1);
    expect(mid).toBeLessThan(0);
    expect(mid).toBeGreaterThan(-40);
    expect(controller.progressAt(1000)).toBeCloseTo(0.5, 3);

    controller.evaluate({ scrollY: 9999 });
    expect(element.style.transform).toBe("translate3d(0px, -40px, 0px)");
    expect(controller.progressAt(9999)).toBe(1);

    controller.destroy();
    engine.reset();
  });

  it("pauses and resumes during active motion without freezing or skipping", () => {
    const engine = createEngine({ name: "ae-pause-mid", manual: true, clock: createManualClock() });
    const element = makeElement();
    const handle = engine.animate(element, { x: [0, 300] }, { duration: 300 });

    frame(engine, 16);
    frame(engine, 150); // elapsed 150ms → x = 150
    const frozen = parseFloat(xOf(element));
    expect(frozen).toBeGreaterThan(100);

    handle.pause();
    frame(engine, 200);
    frame(engine, 200);
    expect(parseFloat(xOf(element))).toBe(frozen); // no drift while paused

    handle.resume();
    frame(engine, 16);
    const resumed = parseFloat(xOf(element));
    expect(resumed).toBeGreaterThan(frozen); // continues forward
    expect(resumed).toBeLessThan(frozen + 40); // and did not skip the pause

    frame(engine, 400);
    expect(handle.state).toBe("finished");
    expect(element.style.transform).toBe("translate3d(300px, 0px, 0px)");
    engine.reset();
  });

  it("keeps running the remaining iterations after a pause", () => {
    const engine = createEngine({ name: "ae-repeat-pause", manual: true, clock: createManualClock() });
    const element = makeElement();
    const handle = engine.animate(element, { x: [0, 100] }, { duration: 150, repeat: 2 });

    frame(engine, 16);
    frame(engine, 84); // elapsed 84ms in the first iteration
    const frozen = parseFloat(xOf(element));
    expect(frozen).toBeGreaterThan(40);

    handle.pause();
    frame(engine, 300);
    expect(parseFloat(xOf(element))).toBe(frozen);

    handle.resume();
    frame(engine, 16);
    expect(parseFloat(xOf(element))).toBeGreaterThan(frozen); // no pause-skip

    frame(engine, 50); // elapsed 150ms = end of iteration 0
    expect(handle.state).toBe("running"); // repeat keeps the pass alive
    expect(handle.progress).toBeCloseTo(150 / 450, 2);

    frame(engine, 500);
    expect(handle.state).toBe("finished");
    expect(element.style.transform).toBe("translate3d(100px, 0px, 0px)");
    engine.reset();
  });

  it("interrupts a running spring and carries the current value forward", () => {
    const engine = createEngine({ name: "ae-spring-interrupt", manual: true, clock: createManualClock() });
    const element = makeElement();
    const first = engine.animate(element, { x: [0, 60] }, { spring: { stiffness: 200, damping: 24 } });

    frame(engine, 16);
    let guard = 0;
    while (parseFloat(xOf(element)) < 20 && guard < 200) {
      frame(engine, 8);
      guard += 1;
    }
    const mid = parseFloat(xOf(element));
    expect(mid).toBeGreaterThan(10); // confirmed mid-flight

    // To-only target: the engine captures the element's current value as the
    // from base, carrying it forward instead of snapping to an authored `from`.
    const second = engine.animate(element, { x: 120 }, { spring: { stiffness: 200, damping: 24 } });
    frame(engine, 16);
    const after = parseFloat(xOf(element));
    expect(after).toBeGreaterThanOrEqual(mid * 0.9); // no snap back toward zero

    guard = 0;
    while (second.state !== "finished" && guard < 800) {
      frame(engine, 16);
      guard += 1;
    }
    expect(second.state).toBe("finished");
    expect(element.style.transform).toBe("translate3d(120px, 0px, 0px)");
    expect(first.state).toBe("finished");
    engine.reset();
  });

  it("seeks to any progress while playing and keeps running from there", () => {
    const engine = createEngine({ name: "ae-seek-live", manual: true, clock: createManualClock() });
    const element = makeElement();
    const handle = engine.animate(element, { x: [0, 200] }, { duration: 200 });

    frame(engine, 16);
    frame(engine, 50); // elapsed 50ms → x = 50
    handle.seek(0.5);

    expect(handle.progress).toBe(0.5);
    expect(parseFloat(xOf(element))).toBe(100); // painted immediately

    frame(engine, 16); // repaints the seek point (the seek resets the frame delta)
    frame(engine, 16);
    expect(parseFloat(xOf(element))).toBeGreaterThan(100); // and keeps running

    frame(engine, 400);
    expect(handle.state).toBe("finished");
    expect(element.style.transform).toBe("translate3d(200px, 0px, 0px)");
    engine.reset();
  });

  it("respects reduced motion by removing travel but keeping the landing state", () => {
    const engine = createEngine({
      name: "ae-reduced",
      manual: true,
      clock: createManualClock(),
      config: { reducedMotion: "force" }
    });
    const element = makeElement();
    const handle = engine.animate(element, { y: [24, 0], opacity: [0, 1] }, { duration: 200 });

    frame(engine, 16);
    frame(engine, 300);

    expect(handle.state).toBe("finished");
    expect(element.style.transform).toBe("translate3d(0px, 0px, 0px)");
    expect(element.style.opacity).toBe("1");
    engine.reset();
  });
});