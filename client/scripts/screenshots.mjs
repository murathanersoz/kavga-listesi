/**
 * README screenshots from the RUNNING app (never mockups).
 *   1. start server + seed a room
 *   2. KAVGA_CODE=XXXX KAVGA_HOSTKEY=... node scripts/screenshots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.KAVGA_BASE ?? "http://localhost:3001";
const CODE = process.env.KAVGA_CODE;
const HOSTKEY = process.env.KAVGA_HOSTKEY;
if (!CODE || !HOSTKEY) {
  console.error("KAVGA_CODE ve KAVGA_HOSTKEY gerekli (seed çıktısından).");
  process.exit(1);
}

mkdirSync("../docs/screenshots", { recursive: true });
const browser = await chromium.launch();

// 1) landing (desktop)
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(BASE + "/");
  await page.waitForTimeout(600);
  await page.screenshot({ path: "../docs/screenshots/landing.png" });
  await page.close();
  console.log("✓ landing");
}

// 2) host lobby with QR (desktop/TV)
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(
    ([code, key]) => {
      localStorage.setItem(`kavga:hostKey:${code}`, key);
      localStorage.setItem("kavga:lastHostRoom", code);
    },
    [CODE, HOSTKEY],
  );
  await page.goto(`${BASE}/host?code=${CODE}`);
  await page.waitForSelector("img[alt*='karekod']", { timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "../docs/screenshots/host-lobby.png" });
  await page.close();
  console.log("✓ host lobby");
}

// 3) phone controller: REAL join flow, seeded fighting queue (390×844)
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${BASE}/p/${CODE}`);
  await page.fill("input[aria-label='Takma ad']", "Misafir");
  await page.click("button:has-text('İçeri gir')");
  await page.waitForSelector("text=Süper oy", { timeout: 10_000 });
  await page.waitForTimeout(1200); // thumbnails
  await page.screenshot({ path: "../docs/screenshots/phone-queue.png" });
  await page.close();
  console.log("✓ phone queue");
}

await browser.close();
console.log("📸 hepsi ../docs/screenshots/ içinde");
