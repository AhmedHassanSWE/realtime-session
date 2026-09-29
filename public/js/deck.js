import { buildSims, startSims } from "./sims.js";
import { initLive } from "./live.js";

const isReceiver = /receiver/i.test(location.search);
const live = initLive({ readOnly: isReceiver });

if (isReceiver) document.querySelector("[data-hud]")?.classList.add("hidden");

// Browsers allow ~6 HTTP/1.1 connections per host, shared by every tab. The speaker view runs two
// more copies of this deck, so only the main window gets a live dashboard, and it loads from the
// other loopback name to get a connection pool of its own.
const demoFrame = document.querySelector("iframe[data-demo]");
if (demoFrame && isReceiver) {
  const placeholder = document.createElement("div");
  placeholder.className = "demo-placeholder";
  placeholder.textContent = "Live dashboard runs in the main window";
  demoFrame.replaceWith(placeholder);
} else if (demoFrame) {
  const alias = { localhost: "127.0.0.1", "127.0.0.1": "localhost" }[location.hostname];
  if (alias) demoFrame.dataset.src = `${location.protocol}//${alias}:${location.port}/dashboard/?embed=1`;
}

Reveal.initialize({
  hash: true,
  width: 1600,
  height: 900,
  margin: 0,
  minScale: 0.2,
  maxScale: 2,
  center: false,
  display: "flex",
  transition: "fade",
  transitionSpeed: "fast",
  backgroundTransition: "none",
  controls: true,
  controlsTutorial: false,
  progress: false,
  slideNumber: false,
  navigationMode: "linear",
  preloadIframes: true,
  viewDistance: 3,
  plugins: [RevealHighlight, RevealNotes],
});

/* ───────── stage: which screen the audience phones should show ───────── */

function parseStage(value) {
  if (!value) return null;
  const [name, poll] = value.split(":");
  return poll ? { name, poll } : { name };
}

function stageFor(slide) {
  const shown = [...slide.querySelectorAll(".fragment.visible[data-stage]")];
  const last = shown[shown.length - 1];
  return parseStage(last?.dataset.stage) ?? parseStage(slide.dataset.stage) ?? { name: "lobby" };
}

/* ───────── chapter HUD + ambient colour ───────── */

const slides = Reveal.getSlides();
const chapterSlides = {};
slides.forEach((s, i) => {
  const ch = s.dataset.chapter ?? "0";
  (chapterSlides[ch] ??= []).push(i);
});

function updateHud(slide) {
  const index = slides.indexOf(slide);
  const current = Number(slide.dataset.chapter ?? 0);
  document.querySelectorAll(".hud .ch").forEach((el) => {
    const ch = Number(el.dataset.ch);
    el.classList.toggle("done", ch < current);
    el.classList.toggle("now", ch === current);
    const list = chapterSlides[ch] ?? [];
    const pos = list.indexOf(index);
    el.style.setProperty("--p", ch === current && list.length ? `${((pos + 1) / list.length) * 100}%` : "0%");
  });
}

function updateGlow(slide) {
  let color = getComputedStyle(slide).getPropertyValue("--accent").trim();
  if (slide.classList.contains("t-arch")) color = "#8b9bd6";
  if (color) document.body.style.setProperty("--glow", color);
}

/* ───────── fragment effects ───────── */

function applyEffect(fragment, on) {
  const effect = fragment.dataset.effect;
  if (effect === "paid") {
    const phone = fragment.closest("section").querySelector("[data-phone]");
    phone?.classList.toggle("paid", on);
    const status = phone?.querySelector("[data-phone-status]");
    if (status) status.textContent = on ? "Payment successful" : "Pending";
  }
  if (effect === "reveal-answer") live.revealAnswer(fragment.dataset.target, on);
}

/* ───────── title ticker ───────── */

const TICKER = [
  ["ws", "#a78bfa", '← {"type":"ORDER_UPDATED","id":1024}'],
  ["sse", "#38bdf8", "← event: order-updated  id: 42"],
  ["cdc", "#34d399", "← UPDATE public.orders  #1025"],
  ["webhook", "#f472b6", "← POST payment_intent.succeeded"],
  ["poll", "#f5b544", "→ GET /api/orders  304 Not Modified"],
  ["ws", "#a78bfa", "→ ping · ← pong"],
  ["sse", "#38bdf8", "← event: notification  id: 43"],
  ["cdc", "#34d399", "← INSERT public.orders  #1031"],
  ["webhook", "#f472b6", "← POST pull_request.opened"],
  ["ws", "#a78bfa", '→ {"type":"TYPING","room":"ops"}'],
];

function startTicker() {
  const box = document.querySelector("[data-ticker]");
  if (!box) return;
  let i = 0;
  const add = () => {
    const [tag, color, text] = TICKER[i++ % TICKER.length];
    const d = new Date();
    const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
    const line = document.createElement("div");
    line.className = "tl-line";
    line.innerHTML = `<span class="t">${t}</span><span class="tag" style="color:${color}">${tag}</span>${text}`;
    box.appendChild(line);
    while (box.children.length > 18) box.firstChild.remove();
  };
  for (let k = 0; k < 18; k++) add();
  setInterval(add, 1100);
}

/* ───────── wiring ───────── */

function onSlide(slide) {
  updateHud(slide);
  updateGlow(slide);
  startSims(slide);
  live.setStage(stageFor(slide));
}

Reveal.on("ready", ({ currentSlide }) => {
  buildSims();
  startTicker();
  onSlide(currentSlide);
});

Reveal.on("slidechanged", ({ currentSlide }) => onSlide(currentSlide));

Reveal.on("fragmentshown", ({ fragments }) => {
  fragments.forEach((f) => applyEffect(f, true));
  live.setStage(stageFor(Reveal.getCurrentSlide()));
});

Reveal.on("fragmenthidden", ({ fragments }) => {
  fragments.forEach((f) => applyEffect(f, false));
  live.setStage(stageFor(Reveal.getCurrentSlide()));
});
