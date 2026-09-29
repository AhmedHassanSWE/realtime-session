import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import { OrdersTable } from "./db.js";
import { signPayload, verifySignature, paymentSucceededEvent } from "./stripe.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 4173;
const KITCHEN_MS = Number(process.env.KITCHEN_MS) || 10_000;
const LONG_POLL_TIMEOUT_MS = Number(process.env.LONG_POLL_TIMEOUT_MS) || 10_000;

const VENDOR = {
  reveal: path.join(ROOT, "node_modules/reveal.js"),
  inter: path.join(ROOT, "node_modules/@fontsource-variable/inter"),
  serif: path.join(ROOT, "node_modules/@fontsource/instrument-serif"),
  mono: path.join(ROOT, "node_modules/@fontsource/jetbrains-mono"),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "localhost";
}

const JOIN_URL = process.env.PUBLIC_URL
  ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/join`
  : `http://${lanAddress()}:${PORT}/join`;

const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip"];

// Tunnels (ngrok, cloudflared) connect from 127.0.0.1, so proxied requests must not count as local.
const isLoopback = (req) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) &&
  !PROXY_HEADERS.some((h) => h in req.headers);

/* ───────────────────────── pipeline log ───────────────────────── */

// Delivered over WebSocket, not SSE: every dashboard already holds one HTTP connection for its
// transport, and browsers only allow ~6 per host on HTTP/1.1.
const logSockets = new Set();
const recentLogs = [];
const BOOT = Date.now();
let logSeq = 0;

function log(stage, text) {
  const entry = { boot: BOOT, seq: ++logSeq, ts: Date.now(), stage, text };
  recentLogs.push(entry);
  if (recentLogs.length > 40) recentLogs.shift();
  for (const ws of logSockets) safeSend(ws, { type: "log", ...entry });
}

/* ───────────────────────── helpers ───────────────────────── */

function sseOpen(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => clearInterval(ping));
}

function sseSend(res, event, data, id) {
  let frame = "";
  if (id !== undefined) frame += `id: ${id}\n`;
  frame += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  res.write(frame);
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function serveFile(res, filePath) {
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) return serveFile(res, path.join(filePath, "index.html"));
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

function safeJoin(base, rel) {
  const target = path.normalize(path.join(base, rel));
  return target.startsWith(base) ? target : null;
}

/* ───────────────────────── orders + transports ───────────────────────── */

const orders = new OrdersTable();
const orderStreams = new Set();
const longPollWaiters = new Set();
const directSockets = new Set();
const realtimeSubs = new Map();

/**
 * The "backend push" path: application code decides to notify clients after a write.
 * Used by long polling, SSE and the direct WebSocket mode.
 */
function pushOrderChange(op, order) {
  const message = { type: "ORDER_CHANGED", op, order, version: orders.version, ts: orders.changedAt };

  for (const res of orderStreams) sseSend(res, "order", message, orders.version);

  const snap = orders.snapshot();
  for (const waiter of longPollWaiters) {
    clearTimeout(waiter.timer);
    json(waiter.res, 200, snap);
  }
  longPollWaiters.clear();

  for (const ws of directSockets) safeSend(ws, message);

  const n = orderStreams.size + directSockets.size;
  if (n) log("push", `app pushed ${op} #${order.id} to ${n} connection${n === 1 ? "" : "s"}`);
}

/**
 * The "realtime database" path: nobody calls this from route handlers.
 * It listens to the table's change feed, like Supabase Realtime listening to the Postgres WAL.
 */
function sqlFor({ eventType, new: row, old }) {
  if (eventType === "INSERT") return `INSERT INTO orders … #${row.id} (${row.customer})`;
  if (eventType === "DELETE") return `DELETE FROM orders WHERE id = ${old.id}`;
  const set = Object.keys(row)
    .filter((k) => k !== "updatedAt" && row[k] !== old[k])
    .map((k) => `${k} = '${row[k]}'`)
    .join(", ");
  return `UPDATE orders SET ${set} WHERE id = ${row.id}`;
}

orders.on("change", (change) => {
  log("db", sqlFor(change));
  let delivered = 0;
  for (const [ws, subs] of realtimeSubs) {
    for (const sub of subs) {
      const f = sub.filter;
      if (f.table && f.table !== change.table) continue;
      if (f.event && f.event !== "*" && f.event !== change.eventType) continue;
      safeSend(ws, { type: "postgres_changes", ref: sub.ref, payload: change, ts: Date.now() });
      delivered += 1;
    }
  }
  const id = change.new.id ?? change.old.id;
  log("cdc", `change feed: ${change.eventType} public.orders #${id}${delivered ? ` → ${delivered} subscriber${delivered === 1 ? "" : "s"}` : ""}`);
});

function safeSend(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

/* kitchen: keeps orders moving so transports can be compared under steady traffic */

let kitchenTimer = null;

function kitchenTick() {
  const active = orders.all().filter((o) => o.status === "preparing" || o.status === "on_the_way");
  const delivered = orders.all().filter((o) => o.status === "delivered");
  if (delivered.length > 2) {
    pushOrderChange("DELETE", orders.delete(delivered[0].id));
    return;
  }
  if (active.length < 2 || Math.random() < 0.2) {
    pushOrderChange("INSERT", orders.insert());
    return;
  }
  const target = active[Math.floor(Math.random() * active.length)];
  const next = orders.advance(target.id);
  if (next) pushOrderChange("UPDATE", next);
}

function setKitchen(on) {
  clearInterval(kitchenTimer);
  kitchenTimer = on ? setInterval(kitchenTick, KITCHEN_MS) : null;
  log("app", on ? `kitchen simulation started: an order changes every ${KITCHEN_MS / 1000} s` : "kitchen simulation stopped");
}

setKitchen(true);

/* ───────────────────────── webhooks ───────────────────────── */

const processedEvents = new Set();

async function deliverWebhook(body, signature, attempt) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
      body,
    });
    log("stripe", `delivery attempt ${attempt} → HTTP ${res.status}`);
  } catch (err) {
    log("stripe", `delivery attempt ${attempt} failed: ${err.message}`);
  }
}

async function handleStripeWebhook(req, res) {
  const raw = await readBody(req);
  log("webhook", `POST /webhooks/stripe (${raw.length} bytes)`);

  const check = verifySignature(raw, req.headers["stripe-signature"]);
  if (!check.ok) {
    log("reject", `rejected: ${check.reason}`);
    return json(res, 400, { error: check.reason });
  }
  log("verify", "signature verified (HMAC-SHA256, timing-safe)");

  const event = JSON.parse(raw);
  if (processedEvents.has(event.id)) {
    log("verify", `duplicate ${event.id} → 200, no side effects (idempotent)`);
    return json(res, 200, { received: true, duplicate: true });
  }
  processedEvents.add(event.id);

  if (event.type === "payment_intent.succeeded") {
    const orderId = Number(event.data.object.metadata.order_id);
    const order = orders.update(orderId, { payment: "paid", status: "preparing" });
    if (order) pushOrderChange("UPDATE", order);
  }
  json(res, 200, { received: true });
}

async function fakeStripePay(orderId, who) {
  const order = orders.get(orderId);
  if (!order) return { ok: false, reason: "unknown order" };
  if (order.payment === "paid") return { ok: false, reason: "already_paid" };

  const event = paymentSucceededEvent(order);
  const body = JSON.stringify(event);
  const signature = signPayload(body);
  log("stripe", `${who} paid €${order.total.toFixed(2)} → ${event.type} (${event.id})`);

  setTimeout(() => deliverWebhook(body, signature, 1), 700);
  setTimeout(() => deliverWebhook(body, signature, 2), 2600);
  return { ok: true, eventId: event.id };
}

/* ───────────────────────── audience ───────────────────────── */

const POLLS = {
  opening: {
    question: "How does your browser know something changed on the server?",
    options: ["WebSockets", "Polling", "Server-Sent Events", "It just… does?", "Depends on the problem"],
  },
  quiz: {
    question: "A customer watches an order-tracking page. They never send anything back. Which transport?",
    options: ["Polling every 2s", "Long polling", "Server-Sent Events", "WebSocket"],
  },
  closing: {
    question: "What will you reach for first next time?",
    options: ["Polling", "SSE", "WebSocket", "Realtime DB", "Webhooks"],
  },
};

const votes = Object.fromEntries(Object.keys(POLLS).map((k) => [k, new Map()]));
const audience = new Map();
const presenters = new Set();
const lastReaction = new Map();
let stage = { name: "lobby" };
let payer = null;

function pollState(id) {
  const poll = POLLS[id];
  const counts = poll.options.map(() => 0);
  for (const choice of votes[id].values()) counts[choice] += 1;
  return { id, question: poll.question, options: poll.options, counts, total: votes[id].size };
}

function stageFor(clientId) {
  const out = { ...stage };
  if (stage.name === "poll" && POLLS[stage.poll]) {
    out.pollData = { question: POLLS[stage.poll].question, options: POLLS[stage.poll].options };
    out.myVote = votes[stage.poll].get(clientId) ?? null;
  }
  if (stage.name === "pay") {
    const order = orders.get(1023);
    out.order = order;
    out.paidByMe = payer === clientId;
  }
  out.audience = audience.size;
  return out;
}

function broadcastStage() {
  for (const [id, client] of audience) {
    for (const res of client.streams) sseSend(res, "stage", stageFor(id));
  }
}

function toPresenters(message) {
  for (const ws of presenters) safeSend(ws, message);
}

function broadcastAudienceCount() {
  toPresenters({ type: "audience", count: audience.size });
  for (const client of audience.values()) {
    for (const res of client.streams) sseSend(res, "count", { audience: audience.size });
  }
}

orders.on("change", (change) => {
  if ((change.new.id ?? change.old.id) === 1023 && stage.name === "pay") broadcastStage();
});

/* ───────────────────────── HTTP routes ───────────────────────── */

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === "/join" || p === "/join/") return serveFile(res, path.join(PUBLIC_DIR, "join/index.html"));
  if (p === "/dashboard" || p === "/dashboard/") return serveFile(res, path.join(PUBLIC_DIR, "dashboard/index.html"));

  /* info + QR */
  if (p === "/api/info") {
    return json(res, 200, {
      joinUrl: JOIN_URL,
      audience: audience.size,
      kitchen: Boolean(kitchenTimer),
      kitchenMs: KITCHEN_MS,
      longPollTimeoutMs: LONG_POLL_TIMEOUT_MS,
    });
  }
  if (p === "/api/qr.svg") {
    const svg = await QRCode.toString(JOIN_URL, {
      type: "svg",
      margin: 1,
      color: { dark: "#0b0d12", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
    res.writeHead(200, { "Content-Type": MIME[".svg"], "Cache-Control": "no-store" });
    return res.end(svg);
  }

  /* audience (phones): SSE down, fetch POST up */
  if (p === "/api/audience/stream") {
    const id = (url.searchParams.get("id") || "").slice(0, 64);
    if (!id) return json(res, 400, { error: "id required" });
    sseOpen(req, res);
    const client = audience.get(id) ?? { streams: new Set() };
    client.streams.add(res);
    audience.set(id, client);
    sseSend(res, "stage", stageFor(id));
    broadcastAudienceCount();
    req.on("close", () => {
      client.streams.delete(res);
      if (client.streams.size === 0) audience.delete(id);
      broadcastAudienceCount();
    });
    return;
  }

  if (p === "/api/audience/react" && req.method === "POST") {
    const { id, emoji } = await readJson(req);
    const allowed = ["🔥", "👏", "🤯", "😂", "❤️", "🚀"];
    const now = Date.now();
    if (!allowed.includes(emoji) || now - (lastReaction.get(id) ?? 0) < 250) return json(res, 429, {});
    lastReaction.set(id, now);
    toPresenters({ type: "reaction", emoji });
    return json(res, 200, { ok: true });
  }

  if (p === "/api/audience/vote" && req.method === "POST") {
    const { id, poll, option } = await readJson(req);
    if (!POLLS[poll] || !Number.isInteger(option) || option < 0 || option >= POLLS[poll].options.length) {
      return json(res, 400, { error: "bad vote" });
    }
    votes[poll].set(id, option);
    toPresenters({ type: "poll", poll: pollState(poll) });
    return json(res, 200, { ok: true });
  }

  /* orders: polling (with ETag), long polling, SSE */
  if (p === "/api/orders" && req.method === "GET") {
    const etag = `W/"v${orders.version}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "no-store" });
      return res.end();
    }
    return json(res, 200, orders.snapshot(), { ETag: etag });
  }

  if (p === "/api/orders/changes" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") || 0);
    if (orders.version > since) return json(res, 200, orders.snapshot());
    const waiter = { res };
    waiter.timer = setTimeout(() => {
      longPollWaiters.delete(waiter);
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
    }, LONG_POLL_TIMEOUT_MS);
    longPollWaiters.add(waiter);
    req.on("close", () => {
      clearTimeout(waiter.timer);
      longPollWaiters.delete(waiter);
    });
    return;
  }

  if (p === "/api/orders/stream") {
    sseOpen(req, res);
    sseSend(res, "snapshot", orders.snapshot(), orders.version);
    orderStreams.add(res);
    log("app", `EventSource connected${req.headers["last-event-id"] ? ` (Last-Event-ID: ${req.headers["last-event-id"]})` : ""}`);
    req.on("close", () => orderStreams.delete(res));
    return;
  }

  /* public: fake Stripe checkout (phones can pay) */
  if (p === "/api/stripe/pay" && req.method === "POST") {
    const { orderId = 1023, id } = await readJson(req);
    const who = isLoopback(req) && !id ? "presenter" : "someone in the room";
    const result = await fakeStripePay(Number(orderId), who);
    if (result.ok && id) {
      payer = id;
      broadcastStage();
    }
    return json(res, result.ok ? 200 : 409, result);
  }

  /* webhook endpoint */
  if (p === "/webhooks/stripe" && req.method === "POST") return handleStripeWebhook(req, res);

  /* presenter-only controls */
  if (p.startsWith("/api/control/")) {
    if (!isLoopback(req)) return json(res, 403, { error: "presenter only" });
    const body = req.method === "POST" ? await readJson(req) : {};
    switch (p) {
      case "/api/control/advance": {
        const candidates = orders.all().filter((o) => o.status === "preparing" || o.status === "on_the_way");
        const target = body.id ? orders.get(body.id) : candidates[0];
        const next = target && orders.advance(target.id);
        if (next) pushOrderChange("UPDATE", next);
        return json(res, 200, { ok: Boolean(next) });
      }
      case "/api/control/kitchen":
        setKitchen(Boolean(body.on));
        return json(res, 200, { on: Boolean(kitchenTimer) });
      case "/api/control/forge": {
        const fake = JSON.stringify(paymentSucceededEvent(orders.get(1023) ?? { id: 1023, total: 24.9 }));
        log("stripe", "attacker POSTs a forged payment_intent.succeeded");
        const r = await fetch(`http://127.0.0.1:${PORT}/webhooks/stripe`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
          body: fake,
        });
        return json(res, 200, { status: r.status });
      }
      case "/api/control/drop": {
        let n = 0;
        for (const ws of [...directSockets, ...realtimeSubs.keys()]) {
          ws.terminate();
          n += 1;
        }
        for (const s of orderStreams) {
          s.destroy();
          n += 1;
        }
        for (const w of longPollWaiters) {
          w.res.destroy();
          n += 1;
        }
        log("chaos", `dropped ${n} live connection${n === 1 ? "" : "s"} (simulated network failure)`);
        return json(res, 200, { dropped: n });
      }
      case "/api/control/reset":
        setKitchen(true);
        orders.reset();
        processedEvents.clear();
        payer = null;
        for (const v of Object.values(votes)) v.clear();
        for (const id of Object.keys(POLLS)) toPresenters({ type: "poll", poll: pollState(id) });
        log("app", "demo reset");
        pushOrderChange("RESET", { id: 0 });
        broadcastStage();
        return json(res, 200, { ok: true });
      default:
        return json(res, 404, { error: "unknown control" });
    }
  }

  /* static */
  if (p.startsWith("/vendor/")) {
    const [, , pkg, ...rest] = p.split("/");
    const base = VENDOR[pkg];
    const file = base && safeJoin(base, rest.join("/"));
    return file ? serveFile(res, file) : json(res, 404, {});
  }

  const file = safeJoin(PUBLIC_DIR, decodeURIComponent(p === "/" ? "/index.html" : p));
  return file ? serveFile(res, file) : json(res, 404, {});
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "internal" });
    else res.end();
  });
});

/* ───────────────────────── WebSocket ───────────────────────── */

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const role = url.searchParams.get("role");
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  if (role === "presenter") {
    if (!isLoopback(req)) return ws.close(4003, "presenter must be local");
    presenters.add(ws);
    safeSend(ws, { type: "audience", count: audience.size });
    safeSend(ws, { type: "info", joinUrl: JOIN_URL });
    for (const id of Object.keys(POLLS)) safeSend(ws, { type: "poll", poll: pollState(id) });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === "stage" && msg.stage?.name) {
        if (JSON.stringify(msg.stage) === JSON.stringify(stage)) return;
        stage = { name: msg.stage.name, ...(msg.stage.poll ? { poll: msg.stage.poll } : {}) };
        broadcastStage();
      }
    });
    ws.on("close", () => presenters.delete(ws));
    return;
  }

  if (role === "logs") {
    for (const entry of recentLogs.slice(-12)) safeSend(ws, { type: "log", ...entry });
    logSockets.add(ws);
    ws.on("close", () => logSockets.delete(ws));
    return;
  }

  /* dashboard clients: direct app events and/or realtime-db subscriptions */
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "ping") return safeSend(ws, { type: "pong", ts: Date.now() });
    if (msg.type === "subscribe" && msg.channel === "orders") {
      directSockets.add(ws);
      safeSend(ws, { type: "SNAPSHOT", ...orders.snapshot() });
      log("app", "WebSocket client subscribed to app events");
    }
    if (msg.type === "realtime:subscribe") {
      const subs = realtimeSubs.get(ws) ?? [];
      subs.push({ ref: msg.ref, filter: msg.filter ?? {} });
      realtimeSubs.set(ws, subs);
      safeSend(ws, { type: "realtime:subscribed", ref: msg.ref });
      log("app", `realtime channel joined: postgres_changes ${msg.filter?.event ?? "*"} on ${msg.filter?.schema ?? "public"}.${msg.filter?.table ?? "*"}`);
    }
  });
  ws.on("close", () => {
    directSockets.delete(ws);
    realtimeSubs.delete(ws);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.listen(PORT, "0.0.0.0", () => {
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log("  Real-Time Web — Frontend Chapter");
  console.log(line);
  console.log(`  Deck (present from this):  http://localhost:${PORT}`);
  console.log(`  Live dashboard:            http://localhost:${PORT}/dashboard`);
  console.log(`  Audience join (QR):        ${JOIN_URL}`);
  console.log(`${line}\n`);
});
