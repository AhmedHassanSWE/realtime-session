// Opens N background dashboards (like deck + speaker view iframes), then checks each transport
// in one more tab: click "Advance", verify the row's stepper actually moved.
//   node scripts/transport-check.mjs [background=0] [modes=polling,longpoll,sse,ws,realtime]
import puppeteer from "puppeteer-core";

const BASE = "http://localhost:4173";
const background = Number(process.argv[2] || 0);
const modes = (process.argv[3] || "polling,longpoll,sse,ws,realtime").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
});

const post = (path, body = {}) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
// reset turns the kitchen back on; stop it so only our click changes order #1024
const resetQuiet = async () => {
  await post("/api/control/reset");
  await post("/api/control/kitchen", { on: false });
};

await resetQuiet();
for (let i = 0; i < background; i++) {
  const p = await browser.newPage();
  await p.goto(`${BASE}/dashboard/?embed=1&t=sse`, { waitUntil: "domcontentloaded" });
}
if (background) console.log(`${background} background dashboards open (SSE mode)`);

const stepOf = (page, id) =>
  page.$eval(`.row[data-id="${id}"] .stepper`, (el) => el.querySelectorAll(".s.on").length).catch(() => -1);

let failed = 0;
for (const t of modes) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(`${BASE}/dashboard/?t=${t}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.row[data-id="1024"]', { timeout: 15000 }).catch(() => {});
  await sleep(1200);
  const before = await stepOf(page, 1024);
  const clicked = Date.now();
  await page.click('[data-action="advance"]');
  let after = before;
  while (Date.now() - clicked < 6000 && after === before) {
    await sleep(100);
    after = await stepOf(page, 1024);
  }
  const ok = after === before + 1;
  if (!ok) failed++;
  const conn = await page.$eval("[data-conn-text]", (el) => el.textContent);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${t.padEnd(9)} steps ${before} → ${after}` +
      `  (${ok ? `${Date.now() - clicked} ms after click` : "no update"}, load ${clicked - t0} ms, conn "${conn}")`
  );
  if (errors.length) console.log("      errors:", errors.join(" | "));
  await page.close();
  await resetQuiet();
  await sleep(300);
}

await post("/api/control/reset");
await browser.close();
process.exit(failed ? 1 : 0);
