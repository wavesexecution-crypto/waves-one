/**
 * Orb-morph primitive vocabulary — the WAVES identity transitions.
 *
 * Each primitive is a pure spec factory: deterministic builds,
 * catalogue-known properties, house easings. The Motion Lab planners
 * compose them into continuous orb → interface → orb sequences.
 */
import { describe, expect, it } from "vitest";
import { getPreset, listPresets } from "../src/presets";
import { defaultMotionTokens as tokens } from "../src/core/tokens";

const PRIMITIVES = [
  "orb-disperse",
  "dissolve",
  "orb-converge",
  "node-connect",
  "card-assemble",
  "text-resolve",
  "workflow-build",
  "crm-populate",
  "notebook-write",
  "data-converge",
  "system-resolve"
];

describe("orb-morph primitives", () => {
  it("registers all ten primitives in the catalogue", () => {
    const names = listPresets().map((preset) => preset.name);
    for (const name of PRIMITIVES) expect(names).toContain(name);
  });

  it("builds deterministic [from, to] property pairs with no magic numbers", () => {
    for (const name of PRIMITIVES) {
      const first = getPreset(name).build("#lab-scene-x", {});
      const second = getPreset(name).build("#lab-scene-x", {});
      expect(first.properties).toEqual(second.properties);
      for (const value of Object.values(first.properties ?? {})) {
        expect(Array.isArray(value)).toBe(true);
        for (const stop of value as unknown[]) {
          expect(typeof stop).toBe("number");
          expect(Number.isFinite(stop)).toBe(true);
        }
      }
    }
  });

  it("enters land at rest and exits leave the stage", () => {
    const converge = getPreset("orb-converge").build("#x", {}).properties as Record<string, number[]>;
    expect(converge.opacity?.[1]).toBe(1);
    expect(converge.scale?.[1]).toBe(1);
    const disperse = getPreset("orb-disperse").build("#x", {}).properties as Record<string, number[]>;
    expect(disperse.opacity?.[1]).toBe(0);
    const dissolve = getPreset("dissolve").build("#x", {}).properties as Record<string, number[]>;
    expect(dissolve.opacity).toEqual([1, 0]);
    const resolve = getPreset("text-resolve").build("#x", {}).properties as Record<string, number[]>;
    expect(resolve.blur?.[1]).toBe(0);
    expect(resolve.blur?.[0]).toBe(tokens.blur.soft);
  });

  it("data enters travel less than hero enters (restraint gradient)", () => {
    const crm = getPreset("crm-populate").build("#x", {}).properties as Record<string, number[]>;
    const card = getPreset("card-assemble").build("#x", {}).properties as Record<string, number[]>;
    expect(Math.abs(crm.y?.[0] ?? 0)).toBeLessThanOrEqual(Math.abs(card.y?.[0] ?? 0));
  });
});
