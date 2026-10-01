/**
 * Capture the REAL SEAI demo sites for the launch reel.
 *
 * These are not mockups and not recreations. Each file is a screenshot of the
 * actual `D:\seai.public\dist/examples/<vertical>.html` page rendered in a real
 * Chromium at the reel's own 1080x1920 artboard, with the project's real
 * self-hosted fonts (Inter / Instrument Serif / JetBrains Mono) and its real
 * curated photography. Nothing in the SEAI project is modified — this only
 * serves and reads it.
 *
 * Every frame is captured after:
 *   - document.fonts.ready, so type is real and not a fallback
 *   - the page's own lazy images forced to load (they are loading="lazy")
 *   - the page's CSS transitions/animations neutralised, so the frame is the
 *     composed end-state rather than whatever was mid-fade
 *   - decode() on every image, so nothing is a half-painted box
 *
 *   node scripts/capture-seai-demos.mjs [--port 5199] [--out public/assets/seai-demos]
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const labDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(labDir, "public", "assets", "seai-demos");
const WIDTH = 1080;
const HEIGHT = 1920;

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const port = argValue("--port", "5199");

/** The seven verticals SEAI actually ships. Order is the reel's running order. */
const VERTICALS = ["restaurant", "gym", "salon", "clinic", "real-estate", "cafe", "business"];

function findChromium() {
  const override = process.env.MOTION_LAB_CHROMIUM?.trim();
  if (override && existsSync(override)) return override;
    const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), "AppData", "Local", "ms-playwright")].filter(Boolean);
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("chromium-") || entry.includes("headless_shell")) continue;
      for (const rel of ["chrome-win64/chrome.exe", "chrome-linux/chrome"]) {
        const exe = path.join(root, entry, rel);
        if (existsSync(exe)) found.push(exe);
      }
    }
  }
  if (found.length === 0) throw new Error("No local Chromium found.");
  return found.sort().pop();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const report = [];

  for (const vertical of VERTICALS) {
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/examples/${vertical}`, { waitUntil: "networkidle", timeout: 60_000 });

    await page.evaluate(async () => {
      // Real type, real images.
      await document.fonts.ready;
      const imgs = Array.from(document.images);
      for (const img of imgs) img.loading = "eager";
      await Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((res) => {
                img.addEventListener("load", res, { once: true });
                img.addEventListener("error", res, { once: true });
              })
        )
      );
      await Promise.all(imgs.filter((i) => i.decode).map((i) => i.decode().catch(() => {})));
    });

    // Neutralise the page's own motion so the capture is a finished frame.
    await page.evaluate(() => {
      const kill = () =>
        document.querySelectorAll("*").forEach((el) => {
          const s = getComputedStyle(el);
          if (s.transitionDuration !== "0s" || (s.animationName && s.animationName !== "none")) {
            el.style.transition = "none";
            el.style.animation = "none";
          }
        });
      kill();
      // Reveal anything still opacity:0 from a scroll-triggered reveal.
      document.querySelectorAll("[data-reveal], .reveal, .is-revealed").forEach((el) => {
        el.style.opacity = "1";
        el.style.transform = "none";
      });
    });
    await sleep(700);

    const frame = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const h1 = document.querySelector("h1");
      return {
        themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
        bg: body.backgroundColor,
        ink: body.color,
        sub: cs.getPropertyValue("--d-sub").trim(),
        faint: cs.getPropertyValue("--d-faint").trim(),
        accent: cs.getPropertyValue("--d-accent").trim(),
        radius: cs.getPropertyValue("--d-radius").trim(),
        display: cs.getPropertyValue("--d-display").trim(),
        heading: h1?.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? null,
        headingFont: h1 ? getComputedStyle(h1).fontFamily.split(",")[0].replace(/"/g, "") : null,
        images: Array.from(document.images).filter((i) => i.naturalWidth > 0).length
      };
    });

    const heroPath = path.join(outDir, `${vertical}-hero.png`);
    await page.screenshot({ path: heroPath });

    // A second, deeper frame: scroll into the page body so the reel can show
    // that these are real multi-section sites, not one hero shot.
    await page.evaluate(() => window.scrollTo({ top: window.innerHeight * 1.6, behavior: "instant" }));
    await sleep(900);
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).filter((i) => i.decode).map((i) => i.decode().catch(() => {})));
    });
    await sleep(400);
    const detailPath = path.join(outDir, `${vertical}-detail.png`);
    await page.screenshot({ path: detailPath });

    const size = (p) => execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Item '${p}').Length`], { encoding: "utf8" }).trim();
    report.push({ vertical, ...frame, heroBytes: Number(size(heroPath)), detailBytes: Number(size(detailPath)) });
    console.log(
      `${vertical.padEnd(12)} ${frame.headingFont?.padEnd(18)} bg=${frame.bg.padEnd(20)} imgs=${frame.images} hero=${(Number(size(heroPath)) / 1024).toFixed(0)}kB`
    );
    await page.close();
  }

  await context.close();
  await browser.close();
  console.log(`\ncaptured ${VERTICALS.length} verticals x 2 frames -> ${outDir}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});