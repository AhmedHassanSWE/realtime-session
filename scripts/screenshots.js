/**
 * Renders every slide to .shots/NN.png for a visual check.
 * Usage: npm start (in another terminal), then npm run shots [-- 5 12 13]
 */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const BASE = process.env.DECK_URL ?? "http://localhost:4173";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const only = process.argv.slice(2).map(Number);

await mkdir(".shots", { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

const phones = [];
for (let i = 0; i < 3; i++) {
  const p = await browser.newPage();
  await p.setViewport({ width: 390, height: 844 });
  await p.goto(`${BASE}/join`, { waitUntil: "networkidle2" }).catch(() => {});
  phones.push(p);
}

const vote = (id, poll, option) =>
  fetch(`${BASE}/api/audience/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, poll, option }),
  });
for (const [i, o] of [0, 0, 0, 1, 2, 4, 0, 2].entries()) await vote(`bot${i}`, "opening", o);
for (const [i, o] of [3, 2, 2, 0, 2, 3].entries()) await vote(`bot${i}`, "quiz", o);
for (const [i, o] of [1, 1, 3, 0, 4].entries()) await vote(`bot${i}`, "closing", o);

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
await page.goto(BASE, { waitUntil: "networkidle2" });
await page.waitForFunction(() => window.Reveal?.isReady());
const total = await page.evaluate(() => Reveal.getTotalSlides());

for (let i = 0; i < total; i++) {
  if (only.length && !only.includes(i)) continue;
  await page.evaluate((n) => Reveal.slide(n, 0, 99), i);
  const wait = await page.evaluate(() => (Reveal.getCurrentSlide().querySelector("[data-sim], [data-arch], iframe") ? 5200 : 900));
  await new Promise((r) => setTimeout(r, wait));
  await page.screenshot({ path: `.shots/${String(i).padStart(2, "0")}.png` });
  process.stdout.write(`${i} `);
}

await page.goto(`${BASE}/dashboard/?t=sse`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: ".shots/dashboard.png" });
await phones[0].screenshot({ path: ".shots/phone.png" });

await fetch(`${BASE}/api/control/reset`, { method: "POST" });
await browser.close();
console.log(`\n${total} slides → .shots/`);
