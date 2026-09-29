import { RealtimeClient } from "/js/realtime-client.js";

const COLORS = {
  poll: "#f5b544",
  long: "#fb8b4b",
  sse: "#38bdf8",
  ws: "#a78bfa",
  db: "#34d399",
  hook: "#f472b6",
  bad: "#f87171",
};

const TRANSPORTS = {
  polling: { label: "Polling", color: COLORS.poll, peek: "setTimeout(poll, 2000) → fetch('/api/orders', { headers: { 'If-None-Match': etag } })" },
  longpoll: { label: "Long polling", color: COLORS.long, peek: "await fetch(`/api/orders/changes?since=${version}`)  // server holds it until there's news" },
  sse: { label: "SSE", color: COLORS.sse, peek: "new EventSource('/api/orders/stream').addEventListener('order', onOrder)" },
  ws: { label: "WebSocket", color: COLORS.ws, peek: "socket.send({ type: 'subscribe', channel: 'orders' })  // backend emits after each write" },
  realtime: { label: "Realtime DB", color: COLORS.db, peek: "realtime.channel('orders').on('postgres_changes', { table: 'orders' }, apply).subscribe()" },
};

const STAGE_COLORS = {
  stripe: COLORS.hook,
  webhook: COLORS.hook,
  verify: COLORS.db,
  reject: COLORS.bad,
  db: COLORS.poll,
  cdc: COLORS.db,
  push: COLORS.ws,
  app: "#8c919d",
  chaos: COLORS.bad,
  client: "#ffffff",
};

const STEPS = [
  ["preparing", "Preparing"],
  ["on_the_way", "On the way"],
  ["delivered", "Delivered"],
];

const $ = (s) => document.querySelector(s);
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

const state = {
  orders: new Map(),
  version: 0,
  transport: null,
  stop: null,
  metrics: { requests: 0, empty: 0, messages: 0, latencies: [] },
};

/* ───────── rendering ───────── */

function renderOrders(flashId) {
  const rows = [...state.orders.values()].sort((a, b) => a.id - b.id);
  $("[data-rows]").innerHTML = rows
    .map((o) => {
      const idx = STEPS.findIndex(([s]) => s === o.status);
      const blocked = o.status === "pending_payment";
      const steps = blocked
        ? `<div class="s wait"><i></i><span>Awaiting payment webhook…</span></div>`
        : STEPS.map(
            ([, label], i) => `<div class="s ${i <= idx ? "on" : ""} ${i === idx ? "now" : ""}"><i></i><span>${label}</span></div>`
          ).join("");
      return `
        <div class="row ${o.id === flashId ? "flash" : ""}" data-id="${o.id}">
          <span class="id">#${o.id}</span>
          <span class="who"><b>${o.customer}</b><span>${o.item}</span></span>
          <span class="total">€${o.total.toFixed(2)}</span>
          <span class="badge ${o.payment}">${o.payment}</span>
          <div class="stepper ${blocked ? "blocked" : ""}">${steps}</div>
        </div>`;
    })
    .join("");
  if (flashId) {
    requestAnimationFrame(() => {
      const row = document.querySelector(`.row[data-id="${flashId}"]`);
      if (row) setTimeout(() => row.classList.remove("flash"), 60);
    });
  }
}

function renderMetrics(changed) {
  const m = state.metrics;
  const values = {
    requests: m.requests,
    empty: m.empty,
    messages: m.messages,
    latency: m.latencies.length ? `${Math.round(m.latencies.reduce((a, b) => a + b, 0) / m.latencies.length)}ms` : "—",
  };
  for (const [k, v] of Object.entries(values)) {
    const el = document.querySelector(`[data-m="${k}"]`);
    if (el.textContent !== String(v)) {
      el.textContent = v;
      if (k === changed) {
        el.classList.remove("tick");
        void el.offsetWidth;
        el.classList.add("tick");
      }
    }
  }
}

function count(key, n = 1) {
  state.metrics[key] += n;
  renderMetrics(key);
}

function latency(ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  state.metrics.latencies.push(ms);
  if (state.metrics.latencies.length > 30) state.metrics.latencies.shift();
  renderMetrics("latency");
}

function setConn(kind, text) {
  const el = $("[data-conn]");
  el.className = `conn ${kind}`;
  $("[data-conn-text]").textContent = text;
}

function log(stage, text, ts = Date.now()) {
  const body = $("[data-log]");
  const d = new Date(ts);
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  const el = document.createElement("div");
  el.className = "entry";
  el.style.setProperty("--c", STAGE_COLORS[stage] ?? "#8c919d");
  el.dataset.ts = ts;
  el.innerHTML = `<span class="t">${t}</span><span class="s">${stage}</span><span class="x"></span>`;
  el.querySelector(".x").textContent = text;
  // server and client entries arrive on different channels; keep them in real order
  let after = body.lastElementChild;
  while (after && Number(after.dataset.ts) > ts) after = after.previousElementSibling;
  body.insertBefore(el, after ? after.nextSibling : body.firstChild);
  while (body.children.length > 40) body.firstChild.remove();
  body.scrollTop = body.scrollHeight;
  while (body.scrollHeight > body.clientHeight && body.children.length > 1) body.firstChild.remove();
}

/* ───────── state updates ───────── */

function applySnapshot(snap, via) {
  const newer = snap.version > state.version;
  state.orders = new Map(snap.orders.map((o) => [o.id, o]));
  // only polling answers measure delivery delay; a resync snapshot just measures time since the change
  if (newer && state.version !== 0 && !via) latency(Date.now() - snap.changedAt);
  state.version = snap.version;
  renderOrders();
  if (via) log("client", `snapshot v${snap.version} via ${via}`);
}

function applyChange({ op, order, version, ts }, via) {
  if (op === "RESET") return refetch(via);
  if (version <= state.version) {
    log("client", `ignored stale v${version} (have v${state.version})`);
    return;
  }
  state.version = version;
  if (op === "DELETE") state.orders.delete(order.id);
  else state.orders.set(order.id, order);
  const ms = Date.now() - ts;
  latency(ms);
  renderOrders(order.id);
  log("client", `${op} #${order.id} via ${via} · ${ms} ms`);
}

async function refetch(via) {
  count("requests");
  const snap = await fetch("/api/orders", { cache: "no-store" }).then((r) => r.json());
  applySnapshot(snap, `${via} resync`);
}

/* ───────── transports ───────── */

function polling() {
  let alive = true;
  let etag = null;
  let timer;
  const tick = async () => {
    try {
      count("requests");
      const res = await fetch("/api/orders", { cache: "no-store", headers: etag ? { "If-None-Match": etag } : {} });
      if (!alive) return;
      setConn("ok", "polling every 2 s");
      if (res.status === 304) count("empty");
      else {
        etag = res.headers.get("ETag");
        const snap = await res.json();
        if (snap.version !== state.version) {
          const before = state.version;
          applySnapshot(snap);
          if (before) log("client", `poll found v${snap.version}`);
        }
      }
    } catch {
      setConn("bad", "request failed");
    }
    if (alive) timer = setTimeout(tick, 2000);
  };
  tick();
  return () => {
    alive = false;
    clearTimeout(timer);
  };
}

function longpoll() {
  let alive = true;
  let controller = null;
  let retry = 0;
  let heldSince = 0;
  const clock = setInterval(() => {
    if (heldSince) setConn("ok", `request held open · ${Math.round((Date.now() - heldSince) / 1000)} s`);
  }, 1000);
  const loop = async () => {
    while (alive) {
      controller = new AbortController();
      try {
        count("requests");
        heldSince = Date.now();
        setConn("ok", "request held open · 0 s");
        const res = await fetch(`/api/orders/changes?since=${state.version}`, { cache: "no-store", signal: controller.signal });
        heldSince = 0;
        if (res.status === 204) {
          count("empty");
          log("client", `no news for ${longPollTimeoutS} s → server answered 204, asking again`);
        } else {
          const snap = await res.json();
          const before = state.version;
          applySnapshot(snap);
          if (before) log("client", `long poll answered with v${snap.version}`);
        }
        retry = 0;
      } catch {
        heldSince = 0;
        if (!alive) return;
        const delay = Math.min(8000, 500 * 2 ** retry++);
        setConn("wait", `reconnecting in ${(delay / 1000).toFixed(1)} s`);
        log("client", `long poll failed, retry in ${delay} ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  };
  loop();
  return () => {
    alive = false;
    clearInterval(clock);
    controller?.abort();
  };
}

function sse() {
  const source = new EventSource("/api/orders/stream");
  source.onopen = () => {
    count("requests");
    setConn("ok", "EventSource open");
  };
  source.addEventListener("snapshot", (e) => applySnapshot(JSON.parse(e.data), "SSE"));
  source.addEventListener("order", (e) => {
    count("messages");
    applyChange(JSON.parse(e.data), "SSE");
  });
  source.onerror = () => {
    setConn("wait", "reconnecting (EventSource retry)");
    log("client", "EventSource error → browser reconnects automatically");
  };
  return () => source.close();
}

function websocket() {
  let socket;
  let retry = 0;
  let timer;
  let heartbeat;
  let closed = false;
  const connect = () => {
    setConn("wait", "connecting…");
    socket = new WebSocket(wsUrl);
    socket.onopen = () => {
      retry = 0;
      count("requests");
      setConn("ok", "WebSocket open");
      socket.send(JSON.stringify({ type: "subscribe", channel: "orders" }));
      heartbeat = setInterval(() => socket.readyState === 1 && socket.send(JSON.stringify({ type: "ping" })), 10000);
    };
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "SNAPSHOT") applySnapshot(msg, "WebSocket");
      if (msg.type === "ORDER_CHANGED") {
        count("messages");
        applyChange(msg, "WebSocket");
      }
    };
    socket.onclose = (e) => {
      clearInterval(heartbeat);
      if (closed) return;
      const delay = Math.min(15000, 500 * 2 ** retry++) * (0.5 + Math.random());
      setConn("wait", `closed ${e.code} · retry in ${(delay / 1000).toFixed(1)} s`);
      log("client", `socket closed (${e.code}), backoff ${Math.round(delay)} ms + jitter`);
      timer = setTimeout(connect, delay);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    socket?.close(1000);
  };
}

function realtime() {
  const client = new RealtimeClient(wsUrl, {
    onConnection: ({ state: s, delay }) => {
      if (s === "open") count("requests");
      if (s === "open") setConn("ok", "realtime channel open");
      if (s === "connecting") setConn("wait", "connecting…");
      if (s === "reconnecting") {
        setConn("wait", `reconnecting in ${(delay / 1000).toFixed(1)} s`);
        log("client", "realtime connection lost, SDK reconnecting");
      }
    },
  });

  client
    .channel("orders")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, (payload, msg) => {
      count("messages");
      const order = payload.eventType === "DELETE" ? payload.old : payload.new;
      applyChange({ op: payload.eventType, order, version: payload.version, ts: Date.parse(payload.commit_timestamp) }, "Realtime DB");
      void msg;
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        log("client", "SUBSCRIBED → refetch snapshot to resync");
        refetch("Realtime DB");
      }
    });

  return () => client.close();
}

const IMPL = { polling, longpoll, sse, ws: websocket, realtime };

function useTransport(name) {
  if (state.transport === name) return;
  state.stop?.();
  state.transport = name;
  state.metrics = { requests: 0, empty: 0, messages: 0, latencies: [] };
  renderMetrics();
  const t = TRANSPORTS[name];
  document.documentElement.style.setProperty("--accent", t.color);
  document.querySelectorAll("[data-t]").forEach((b) => b.classList.toggle("active", b.dataset.t === name));
  $("[data-peek]").textContent = t.peek;
  log("client", `switched to ${t.label}`);
  if (kitchen) log("client", `Kitchen is on: an order changes every ${kitchenS} s`);
  else log("client", "nothing changes until you click “Advance an order” or turn on the Kitchen");
  state.stop = IMPL[name]();
  history.replaceState(null, "", `?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), t: name })}`);
}

/* ───────── server log stream ───────── */

// A WebSocket, not EventSource: the demo transports already use this origin's
// ~6 HTTP/1.1 connections, and WebSockets don't count against that pool.
let lastServerLog = { boot: 0, seq: 0 };

function startLogStream() {
  const socket = new WebSocket(`${wsUrl}?role=logs`);
  socket.onmessage = (e) => {
    const entry = JSON.parse(e.data);
    if (entry.type !== "log") return;
    if (entry.boot === lastServerLog.boot && entry.seq <= lastServerLog.seq) return;
    lastServerLog = { boot: entry.boot, seq: entry.seq };
    log(entry.stage, entry.text, entry.ts);
  };
  socket.onclose = () => setTimeout(startLogStream, 1000);
}

/* ───────── controls ───────── */

let kitchen = false;
let longPollTimeoutS = 10;
let kitchenS = 10;

function setKitchenUi(on) {
  kitchen = on;
  document.querySelector('[data-action="kitchen"]').classList.toggle("on", on);
}

async function control(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (res.status === 403) {
    log("reject", `${path} refused — demo controls only work when the dashboard is opened from localhost`);
  }
  return res.json().catch(() => ({}));
}

document.querySelector("[data-transports]").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-t]");
  if (btn) useTransport(btn.dataset.t);
});

document.querySelector(".controls").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  switch (btn.dataset.action) {
    case "kitchen": {
      const r = await control("/api/control/kitchen", { on: !kitchen });
      if (typeof r.on === "boolean") setKitchenUi(r.on);
      break;
    }
    case "advance":
      await control("/api/control/advance");
      break;
    case "pay": {
      const r = await control("/api/stripe/pay", { orderId: 1023 });
      if (!r.ok) log("client", r.reason === "already_paid" ? "#1023 is already paid" : `pay failed: ${r.reason}`);
      break;
    }
    case "forge":
      await control("/api/control/forge");
      break;
    case "drop":
      await control("/api/control/drop");
      break;
    case "reset": {
      await control("/api/control/reset");
      setKitchenUi(true);
      const name = state.transport;
      state.transport = null;
      state.version = 0;
      $("[data-log]").innerHTML = "";
      useTransport(name);
      break;
    }
  }
});

const info = await fetch("/api/info").then((r) => r.json()).catch(() => ({}));
setKitchenUi(Boolean(info.kitchen));
if (info.longPollTimeoutMs) longPollTimeoutS = info.longPollTimeoutMs / 1000;
if (info.kitchenMs) kitchenS = info.kitchenMs / 1000;

startLogStream();
useTransport(new URLSearchParams(location.search).get("t") in IMPL ? new URLSearchParams(location.search).get("t") : "polling");
