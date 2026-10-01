/**
 * Capture the REAL Motion Lab UI for the demo reel.
 *
 * Captures the actual Motion Lab UI running in the browser:
 * - The transport controls (play/pause/restart/reverse)
 * - The stage with a real GSAP scene playing
 * - The render/export UI
 *
 * This is NOT a mockup — it's the actual product UI captured at 1080x1920.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import os from "node:os";

const labDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(labDir, "..");
const outDir = path.join(appDir, "public", "assets", "motion-lab-captures");

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const port = Number(argValue("--port", "5181"));

const WIDTH = 1080;
const HEIGHT = 1920;

function findChromium() {
  const override = process.env.MOTION_LAB_CHROMIUM?.trim();
  if (override && existsSync(override)) return override;
  const cacheRoots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), "AppData", "Local", "ms-playwright")].filter(Boolean);
  const candidates = [];
  for (const root of cacheRoots) {
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
        if (existsSync(exe)) candidates.push({ exe, mtime: statSync(exe).mtimeMs });
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    throw new Error("No local Chromium found. Install Playwright browsers or set MOTION_LAB_CHROMIUM.");
  }
  return candidates[0].exe;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

  // Capture 1: Full Motion Lab UI with seai-launch-reel playing
  const page1 = await context.newPage();
  await page1.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page1.waitForTimeout(5000);
  await page1.evaluate(async () => {
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
  await page1.evaluate(() => {
    document.querySelectorAll("*").forEach((el) => {
      const s = getComputedStyle(el);
      if (s.transitionDuration !== "0s" || s.animationName !== "none") {
        el.style.transition = "none";
        el.style.animation = "none";
      }
    });
  });
  await sleep(800);
  await page1.screenshot({ path: path.join(outDir, "motion-lab-stage.png"), fullPage: false });
  await page1.close();

  // Capture 2: Render/export UI
  const page2 = await context.newPage();
  await page2.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page2.waitForTimeout(3000);
  await page2.evaluate(() => {
    const btn = document.querySelector('button[onclick*="renderNow"]') || Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Render'));
    if (btn) btn.click();
  });
  await sleep(3000);
  await page2.screenshot({ path: path.join(outDir, "motion-lab-render.png"), fullPage: false });
  await page2.close();

  // Capture 3: Download/export UI
  const page3 = await context.newPage();
  await page3.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page3.waitForTimeout(3000);
  await page3.evaluate(() => {
    const link = document.querySelector('a[href*="export"]');
    if (link) link.scrollIntoView();
  });
  await sleep(500);
  await page3.screenshot({ path: path.join(outDir, "motion-lab-export.png"), fullPage: false });
  await page3.close();

  await context.close();
  await browser.close();
  console.log("Captures saved to " + outDir);
  console.log(" - motion-lab-stage.png");
  console.log(" - motion-lab-render.png");
  console.log(" - motion-lab-export.png");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});