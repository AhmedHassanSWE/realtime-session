const ID_KEY = "rt-audience-id";
const clientId =
  localStorage.getItem(ID_KEY) ??
  (() => {
    const id = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    localStorage.setItem(ID_KEY, id);
    return id;
  })();

const view = document.querySelector("[data-view]");
const status = document.querySelector("[data-status]");
const statusText = document.querySelector("[data-status-text]");

let stage = null;
let audience = 0;

const ACCENTS = { lobby: "#a78bfa", poll: "#38bdf8", pay: "#f472b6" };

function setStatus(kind, text) {
  status.className = `status ${kind}`;
  statusText.textContent = text;
}

function post(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: clientId, ...body }),
  }).then((r) => r.json().catch(() => ({})));
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/* ───────── views ───────── */

function renderLobby() {
  view.innerHTML = `
    <div class="k">You're in</div>
    <h1>Keep this tab <em>open.</em></h1>
    <p>This screen will change as the talk moves on — a vote, and at one point a button that pays for someone's pizza.</p>
    <p class="muted">Tap a reaction below. It lands on the big screen instantly.</p>
    <div>
      <div class="big-count">${audience}</div>
      <p class="muted">people connected right now</p>
    </div>`;
}

function renderPoll() {
  const { pollData, myVote } = stage;
  view.innerHTML = `
    <div class="k">Vote</div>
    <h2>${esc(pollData.question)}</h2>
    <div class="options">
      ${pollData.options.map((o, i) => `<button data-opt="${i}" class="${myVote === i ? "chosen" : ""}">${esc(o)}</button>`).join("")}
    </div>
    <p class="muted">${myVote === null ? "Results appear live on the screen." : "Vote received. Tap another option to change it."}</p>`;
  view.querySelectorAll("[data-opt]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const option = Number(btn.dataset.opt);
      stage.myVote = option;
      renderPoll();
      await post("/api/audience/vote", { poll: stage.poll, option });
    })
  );
}

function renderPay() {
  const order = stage.order;
  const paid = order?.payment === "paid";
  let result = "";
  if (paid && stage.paidByMe) {
    result = `<div class="result"><h2>You paid. 🎉</h2><p>Look at the big screen: Stripe → webhook → signature check → database → realtime → UI.</p></div>`;
  } else if (paid) {
    result = `<div class="result other"><h2>Someone was faster.</h2><p>The order was paid exactly once, no matter how many people tapped. That's idempotency.</p></div>`;
  }
  view.innerHTML = `
    <div class="k">Act II · payment</div>
    <h1>Pay for <em>Nora's</em> pizza.</h1>
    <div class="order">
      <div class="line"><span>Order</span><span>#${order?.id ?? 1023}</span></div>
      <div class="line"><span>2× Margherita</span><span>€24.90</span></div>
      <div class="line"><span>Total</span><span>€${(order?.total ?? 24.9).toFixed(2)}</span></div>
    </div>
    ${paid ? result : `<button class="pay" data-pay>Pay with Stripe (test)</button><p class="muted">First tap wins. Nobody is charged — Stripe is simulated.</p>`}`;
  view.querySelector("[data-pay]")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = "Sending to Stripe…";
    await post("/api/stripe/pay", { orderId: 1023 });
  });
}

function render() {
  if (!stage) return;
  document.documentElement.style.setProperty("--accent", ACCENTS[stage.name] ?? ACCENTS.lobby);
  if (stage.name === "poll" && stage.pollData) return renderPoll();
  if (stage.name === "pay") return renderPay();
  return renderLobby();
}

/* ───────── connection ───────── */

const source = new EventSource(`/api/audience/stream?id=${encodeURIComponent(clientId)}`);

source.onopen = () => setStatus("ok", "live · SSE");
source.onerror = () => setStatus("wait", "reconnecting…");

source.addEventListener("stage", (e) => {
  const next = JSON.parse(e.data);
  audience = next.audience ?? audience;
  const changed = !stage || stage.name !== next.name || stage.poll !== next.poll || next.name === "pay";
  stage = next;
  if (changed) render();
});

source.addEventListener("count", (e) => {
  audience = JSON.parse(e.data).audience;
  if (stage?.name === "lobby") {
    const el = view.querySelector(".big-count");
    if (el) el.textContent = String(audience);
  }
});

/* ───────── reactions ───────── */

document.querySelector("[data-react]").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-emoji]");
  if (!btn) return;
  btn.classList.add("pop");
  setTimeout(() => btn.classList.remove("pop"), 120);
  navigator.vibrate?.(10);
  post("/api/audience/react", { emoji: btn.dataset.emoji });
});
