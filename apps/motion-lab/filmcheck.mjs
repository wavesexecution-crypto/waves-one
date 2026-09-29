import { chromium } from "playwright-core";

const errors = [];
const browser = await chromium.launch({
  executablePath: "C:\\Users\\hp\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe",
  headless: true
});
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("http://localhost:5173/", { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  const snapshot = await page.evaluate(() => {
    const acts = [...document.querySelectorAll("#lab-stage [data-act]")].map((el) => ({
      act: el.getAttribute("data-act"),
      visible: el.style.opacity !== "0",
      text: (el.textContent ?? "").slice(0, 60)
    }));
    const dots = document.querySelectorAll("#lab-stage .lab-net-dot").length;
    const rev = document.querySelector(".lab-rev")?.textContent ?? null;
    return JSON.stringify({ acts, dots, rev });
  });
  console.log("FILM_STATE:", snapshot);
  console.log("CONSOLE_ERRORS:", errors.length === 0 ? "none" : errors.slice(0, 3).join(" | "));
  if (errors.length > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
console.log("FILMCHECK_DONE");
