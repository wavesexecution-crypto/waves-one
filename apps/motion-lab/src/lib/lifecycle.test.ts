/**
 * Lifecycle guard regression tests — the "never stuck" contract.
 *
 * Simulates the exact failure modes seen after audio input (an await that
 * never settles, a superseded operation writing late, metadata with no
 * usable duration) and proves each resolves to a terminal outcome within
 * a bounded wait instead of hanging indefinitely.
 */
import { describe, expect, it, vi } from "vitest";
import { createOpToken, fetchJson, pickDuration, TimeoutError, withTimeout } from "./lifecycle";

describe("withTimeout", () => {
  it("resolves the inner value when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1000, "unit")).resolves.toBe("done");
  });

  it("rejects with TimeoutError when the await never settles (the stuck-audio case)", async () => {
    const hanging = new Promise<string>(() => {
      /* never settles — decode/bridge/export without a ceiling */
    });
    const start = Date.now();
    await expect(withTimeout(hanging, 30, "stuck-stage")).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("never masks an inner rejection as a timeout", async () => {
    const failure = Promise.reject(new Error("bridge down"));
    await expect(withTimeout(failure, 1000, "unit")).rejects.toThrow("bridge down");
  });

  it("clears its timer on settle", async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(Promise.resolve(1), 60_000, "unit");
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createOpToken", () => {
  it("invalidates the previous operation when a new one starts (reload cancels)", () => {
    const token = createOpToken();
    const first = token.next();
    expect(token.alive(first)).toBe(true);
    const second = token.next();
    expect(token.alive(first)).toBe(false);
    expect(token.alive(second)).toBe(true);
  });

  it("a late continuation from a superseded upload must not write state", async () => {
    const token = createOpToken();
    const writes: string[] = [];
    const stale = token.next();
    // User reloads audio while the first upload is still in flight.
    const current = token.next();
    // The stale continuation resolves late and checks ownership first.
    await Promise.resolve();
    if (token.alive(stale)) writes.push("stale-write");
    if (token.alive(current)) writes.push("current-write");
    expect(writes).toEqual(["current-write"]);
  });
});

describe("pickDuration", () => {
  it("takes the first finite positive media duration", () => {
    expect(pickDuration([Number.NaN, 0, -40, Number.POSITIVE_INFINITY, 3200.4])).toBe(3200);
  });

  it("returns null when no usable duration exists (never a hardcoded guess)", () => {
    expect(pickDuration([null, undefined, 0, -1, Number.NaN])).toBeNull();
  });
});

describe("fetchJson", () => {
  it("resolves parsed JSON for a fast same-origin-style fetch", async () => {
    const payload = { ok: true, revision: 7 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }))
    );
    await expect(fetchJson("http://lab/state", 1000, "unit")).resolves.toEqual(payload);
  });

  it("rejects non-2xx without hanging", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    );
    await expect(fetchJson("http://lab/state", 1000, "unit")).rejects.toThrow("HTTP 500");
  });
});
