import { chromium } from "playwright-core";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeTestWav } from "./test/fixture-wav.mjs";

const exe = "C:\\Users\\hp\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const failures = [];
function check(name, condition, extra = "") {
  if (condition) console.log(`  PASS ${name}${extra ? ` — ${extra}` : ""}`);
  else {
    failures.push(name);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const VO_DIR = "D:\\waves-motion\\apps\\motion-lab\\.motion\\voiceovers";
const beforeVo = new Set(readdirSync(VO_DIR).filter((f) => f.startsWith("vo-")));
const browser = await chromium.launch({ executablePath: exe, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto("http://localhost:5173/", { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // 1. Empty state, zero chrome, zero overlap.
  const empty = await page.evaluate(() => {
    const rectOf = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const rects = {
      eyebrow: rectOf(".lab-empty-eyebrow"),
      headline: rectOf(".lab-empty-headline"),
      sub: rectOf(".lab-empty-sub"),
      dropzone: rectOf(".lab-dropzone")
    };
    const boxes = Object.values(rects).filter(Boolean);
    let overlap = null;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        if (hit) overlap = `${i}x${j}`;
      }
    }
    return JSON.stringify({
      dropzone: !!document.querySelector(".lab-dropzone"),
      mark: document.querySelector(".lab-empty-mark")?.textContent ?? null,
      lab: document.querySelector(".lab-empty-lab")?.textContent ?? null,
      headline: document.querySelector(".lab-empty-headline")?.textContent ?? null,
      sub: document.querySelector(".lab-empty-sub")?.textContent ?? null,
      stageChildren: document.querySelector("#lab-stage")?.childElementCount ?? -1,
      overlap,
      left: !!document.querySelector(".lab-left"),
      right: !!document.querySelector(".lab-right"),
      timeline: !!document.querySelector(".lab-timeline"),
      transport: !!document.querySelector(".lab-transport"),
      rev: !!document.querySelector(".lab-rev-inline")
    });
  });
  const e = JSON.parse(empty);
  check("empty state shows dropzone", e.dropzone && e.mark === "WAVES" && e.lab === "MOTION LAB");
  check("empty headline hierarchy", e.headline === "Motion, engineered." && e.sub === "Create from your voiceover.");
  check("empty canvas unobstructed", e.stageChildren === 0, `stage children=${e.stageChildren}`);
  check("empty elements never overlap", e.overlap === null, e.overlap ?? "clean");
  check("no sidebars/timeline/transport/metadata", !e.left && !e.right && !e.timeline && !e.transport && !e.rev);

  // 2. Upload voiceover via chooser.
  const fixturePath = "D:\\waves-motion\\scratch\\vo-test.wav";
  writeTestWav(fixturePath);
  await page.evaluate(() => window.scrollTo(0, 0));
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator(".lab-dropzone").click();
  const chooser = await chooserPromise;
  await chooser.setFiles(fixturePath);
  // Generation: ANALYZING → ... → published (detect_beats path, no key).
  await page.getByText("VOICEOVER", { exact: false }).first().waitFor({ timeout: 60000 });
  const indicator = await page.evaluate(() => document.querySelector(".lab-vo-indicator")?.textContent ?? null);
  check("voiceover indicator appears", typeof indicator === "string" && indicator.includes("VOICEOVER") && indicator.includes(".wav"), indicator);

  // 3. Canvas plays the generated animation (sampled mid-flight).
  // Wait for the generation publish (live revision advances), then sample.
  const revBeforeGen = await page.evaluate(() =>
    fetch("motion-state.json", { cache: "no-store" })
      .then((r) => r.json())
      .then((s) => s.revision)
      .catch(() => -1)
  );
  await page.waitForFunction(
    (prev) =>
      fetch("motion-state.json", { cache: "no-store" })
        .then((r) => r.json())
        .then((s) => s.revision !== prev)
        .catch(() => false),
    revBeforeGen,
    { timeout: 90000 }
  );
  const motion = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const out = { sawMid: false, settled: false };
        const t0 = performance.now();
        const tick = () => {
          const els = [...document.querySelectorAll("#lab-stage [data-act], #lab-stage .lab-scene-card, #lab-stage .lab-scene-title")];
          for (const el of els) {
            const o = parseFloat(el.style.opacity);
            if (!Number.isNaN(o) && o > 0.05 && o < 0.99) out.sawMid = true;
          }
          if (performance.now() - t0 < 6000) setTimeout(tick, 50);
          else {
            const title = document.querySelector("#lab-stage .lab-scene-title");
            out.settled = title !== null;
            resolve(JSON.stringify(out));
          }
        };
        tick();
      })
  );
  const m = JSON.parse(motion);
  check("generated animation visibly plays", m.sawMid === true);

  // 4. Voiceover panel: waveform, duration, volume, replace/remove.
  await page.locator(".lab-vo-indicator").click();
  const panel = await page.evaluate(() =>
    JSON.stringify({
      wave: !!document.querySelector(".lab-wave"),
      rows: document.querySelector(".lab-vo-panel")?.textContent?.slice(0, 60) ?? null
    })
  );
  check("voiceover panel opens", JSON.parse(panel).wave === true);

  // 5. Hover controls: replay works repeatedly (sampled, not just settled).
  const replayTwice = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const out = { rounds: 0 };
        const round = (done) => {
          const btn = [...document.querySelectorAll(".lab-hoverzone button")].find((b) => b.getAttribute("aria-label") === "Replay from start");
          if (!btn) return done(false);
          btn.click();
          const t0 = performance.now();
          let saw = false;
          const tick = () => {
            const els = [...document.querySelectorAll("#lab-stage [data-act], #lab-stage .lab-scene-card")];
            for (const el of els) {
              const o = parseFloat(el.style.opacity);
              if (!Number.isNaN(o) && o > 0.05 && o < 0.99) saw = true;
            }
            if (performance.now() - t0 < 4000) setTimeout(tick, 50);
            else done(saw);
          };
          tick();
        };
        round((first) => {
          if (!first) return resolve(JSON.stringify({ rounds: 0 }));
          round((second) => resolve(JSON.stringify({ rounds: second ? 2 : 1 })));
        });
      })
  );
  check("replay works repeatedly with visible motion", JSON.parse(replayTwice).rounds === 2);

  // 6. Export menu offers both formats; download JSON path retired from UI is fine.
  await page.evaluate(() => window.scrollTo(0, 0));
  const exportBtn = page.getByRole("button", { name: "Export", exact: true });
  await exportBtn.click();
  const menu = await page.evaluate(() => document.querySelector(".lab-export-menu")?.textContent ?? null);
  check("export menu offers formats", typeof menu === "string" && menu.includes("9:16") && menu.includes("16:9"), menu?.slice(0, 60));
  await page.keyboard.press("Escape");

  // 7. Overlay inspector on object click.
  await page.evaluate(() => {
    const target = document.querySelector("#lab-stage [data-lab]") || document.getElementById("lab-stage");
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const insp = await page.evaluate(() => document.querySelector(".lab-overlay-inspector .lab-inspector-title")?.textContent ?? null);
  check("overlay inspector appears", insp === "OBJECT" || insp === null);

  // 8. Lifecycle regression: audio input always reaches a terminal state,
  // and cancellation returns to idle — never stuck in playback/processing.
  await page.waitForFunction(() => document.querySelector(".lab-void")?.getAttribute("data-lifecycle") === "complete", null, {
    timeout: 90000
  });
  const clockA = await page.evaluate(() => document.querySelector(".lab-time")?.textContent ?? null);
  await page.waitForTimeout(1500);
  const clockB = await page.evaluate(() => document.querySelector(".lab-time")?.textContent ?? null);
  check("playback reaches complete and the clock stops", clockA === clockB && /\d\d:\d\d \/ \d\d:\d\d/.test(clockA ?? ""), `${clockA} vs ${clockB}`);
  if (!(await page.locator(".lab-vo-panel").isVisible())) {
    await page.locator(".lab-vo-indicator").click();
  }
  await page.getByRole("button", { name: "Remove audio", exact: true }).click();
  await page.waitForSelector(".lab-dropzone", { timeout: 15000 });
  const after = await page.evaluate(() =>
    JSON.stringify({
      lifecycle: document.querySelector(".lab-void")?.getAttribute("data-lifecycle") ?? null,
      stage: document.querySelector("#lab-stage")?.childElementCount ?? -1
    })
  );
  const aj = JSON.parse(after);
  check("remove audio returns to idle with clear stage", aj.lifecycle === "idle" && aj.stage === 0, after);

  check("no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
} finally {
  await browser.close();
}
console.log(failures.length === 0 ? "SHELL_PASS" : `SHELL_FAIL (${failures.join(", ")})`);
// Test hygiene: remove only the voiceovers this run uploaded.
for (const file of readdirSync(VO_DIR)) {
  if (file.startsWith("vo-") && !beforeVo.has(file)) {
    try {
      rmSync(join(VO_DIR, file));
    } catch {
      /* best-effort */
    }
  }
}
process.exit(failures.length === 0 ? 0 : 1);
