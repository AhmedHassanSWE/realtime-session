/**
 * Animated sequence diagrams. Each sim runs only while its slide is visible.
 * All geometry uses offset* (layout pixels) because Reveal scales slides with a CSS transform.
 */

class Stopped extends Error {}

class Ctx {
  alive = true;
  timers = new Set();
  anims = new Set();

  wait(ms) {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Stopped());
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.alive ? resolve() : reject(new Stopped());
      }, ms);
      this.timers.add(t);
    });
  }

  check() {
    if (!this.alive) throw new Stopped();
  }

  stop() {
    this.alive = false;
    this.timers.forEach(clearTimeout);
    this.anims.forEach((a) => a.cancel());
    this.timers.clear();
    this.anims.clear();
  }
}

const rand = (a, b) => a + Math.random() * (b - a);

function machineHTML(side) {
  if (side.kind === "server" || side.kind === "ext") {
    return `
      <div class="mbar"><i></i><i></i><i></i><span>${side.url}</span></div>
      <div class="rack"><i></i><i></i></div>
      <div class="mbody">
        <div class="mname">${side.name}</div>
        <div class="mver" data-ver>v1</div>
      </div>
      <div class="bubble" data-bubble></div>`;
  }
  return `
    <div class="mbar"><i></i><i></i><i></i><span>${side.url}</span></div>
    <div class="mbody">
      <div class="mname">${side.name}</div>
      <div class="mver" data-ver>v1</div>
      <div class="mtag" data-tag>fresh</div>
    </div>
    <div class="bubble" data-bubble></div>`;
}

class Lane {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    root.innerHTML = `
      <div class="sim-head"><span>${opts.title}</span><span class="live">Simulation</span></div>
      <div class="sim-stage">
        <div class="machine ${opts.left.kind}" data-side="left">${machineHTML(opts.left)}</div>
        <div class="wire" data-wire>
          <div class="wire-line"></div>
          <div class="wire-label top" data-wlabel></div>
        </div>
        <div class="machine ${opts.right.kind}" data-side="right">${machineHTML(opts.right)}</div>
      </div>
      <div class="sim-caption" data-caption>…</div>
      <div class="sim-stats">
        ${opts.stats
          .map((s) => `<div class="stat ${s.cls ?? ""}" data-stat="${s.key}"><div class="n">0</div><div class="l">${s.label}</div></div>`)
          .join("")}
      </div>`;
    this.wireEl = root.querySelector("[data-wire]");
    this.sides = {
      left: root.querySelector('[data-side="left"]'),
      right: root.querySelector('[data-side="right"]'),
    };
  }

  reset() {
    this.wireEl.querySelectorAll(".pkt").forEach((p) => p.remove());
    this.wire("");
    this.wireLabel("");
    this.setVer("left", 1);
    this.setVer("right", 1);
    this.setTag("left", "fresh", "");
    this.setTag("right", "", "");
    this.opts.stats.forEach((s) => this.stat(s.key, s.initial ?? "0"));
    this.caption("…");
  }

  side(name) {
    return this.sides[name];
  }

  setVer(side, v) {
    const el = this.side(side).querySelector("[data-ver]");
    if (el) el.textContent = typeof v === "number" ? `v${v}` : v;
  }

  setTag(side, text, state) {
    const el = this.side(side).querySelector("[data-tag]");
    if (!el) return;
    el.textContent = text;
    el.style.visibility = text ? "visible" : "hidden";
    el.className = `mtag ${state ?? ""}`;
  }

  pulse(side) {
    const el = this.side(side);
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
  }

  bubble(side, text, ms = 1600) {
    const el = this.side(side).querySelector("[data-bubble]");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), ms);
  }

  caption(html) {
    this.root.querySelector("[data-caption]").innerHTML = html;
  }

  stat(key, value) {
    const el = this.root.querySelector(`[data-stat="${key}"] .n`);
    if (el) el.innerHTML = value;
  }

  wire(state) {
    this.wireEl.classList.toggle("open", state === "open");
    this.wireEl.classList.toggle("broken", state === "broken");
  }

  wireLabel(text) {
    this.root.querySelector("[data-wlabel]").textContent = text;
  }

  /** Moves a packet across the wire. Resolves with the element when it arrives. */
  async send(ctx, dir, label, { cls = "", row = dir === "ltr" ? "req" : "res", ms = 850, keep = false } = {}) {
    ctx.check();
    const el = document.createElement("div");
    el.className = `pkt ${row} ${cls}`;
    el.textContent = label;
    this.wireEl.appendChild(el);
    const max = Math.max(0, this.wireEl.offsetWidth - el.offsetWidth);
    const [from, to] = dir === "ltr" ? [0, max] : [max, 0];
    const anim = el.animate(
      [
        { transform: `translateX(${from}px)`, opacity: 0 },
        { opacity: 1, offset: 0.12 },
        { transform: `translateX(${to}px)`, opacity: 1 },
      ],
      { duration: ms, easing: "cubic-bezier(.45,.05,.35,1)", fill: "forwards" }
    );
    ctx.anims.add(anim);
    try {
      await anim.finished;
    } catch {
      el.remove();
      throw new Stopped();
    } finally {
      ctx.anims.delete(anim);
    }
    if (!keep) {
      const out = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, delay: 150, fill: "forwards" });
      out.finished.then(() => el.remove()).catch(() => el.remove());
    }
    ctx.check();
    return el;
  }
}

const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const secs = (ms) => `${(ms / 1000).toFixed(1)}<small>s</small>`;

/* ───────────────────────── HTTP ───────────────────────── */

async function runHttp(lane, ctx) {
  lane.reset();
  lane.stat("req", "0");
  lane.stat("stale", secs(0));
  let serverV = 1;
  lane.setVer("left", "—");
  lane.setTag("left", "empty", "stale");
  lane.caption("The page loads and asks for the orders. Once.");
  await ctx.wait(700);
  await lane.send(ctx, "ltr", "GET /orders");
  lane.pulse("right");
  await lane.send(ctx, "rtl", "200 · v1", { cls: "ok" });
  lane.stat("req", "1");
  lane.setVer("left", 1);
  lane.setTag("left", "fresh", "");
  lane.caption("The connection closes. The browser now holds a <b>snapshot</b> of v1.");

  await ctx.wait(1800);
  const staleSince = performance.now();
  const ticker = setInterval(() => lane.stat("stale", secs(performance.now() - staleSince)), 100);
  ctx.timers.add(ticker);
  const labels = ["#1024 → shipped", "#1025 → delivered", "#1026 → preparing", "#1027 → cancelled"];
  for (let i = 0; i < labels.length; i++) {
    serverV += 1;
    lane.setVer("right", serverV);
    lane.pulse("right");
    lane.bubble("right", labels[i]);
    lane.setTag("left", `stale · ${i + 1} behind`, "stale");
    lane.caption(
      i === 0
        ? "Something changed on the server. <b>Nothing reaches the browser.</b>"
        : `The server is at v${serverV}. The browser still shows v1 — and has no way to know.`
    );
    await ctx.wait(2300);
  }
  clearInterval(ticker);
  await ctx.wait(1500);
}

/* ───────────────────────── Polling ───────────────────────── */

async function runPolling(lane, ctx) {
  lane.reset();
  let serverV = 1;
  let clientV = 1;
  const events = [];
  const delays = [];
  let requests = 0;
  let empty = 0;
  lane.stat("delay", secs(0));
  lane.stat("empty", "0<small>%</small>");

  const server = (async () => {
    await ctx.wait(1600);
    while (ctx.alive) {
      serverV += 1;
      events.push({ v: serverV, t: performance.now() });
      lane.setVer("right", serverV);
      lane.pulse("right");
      lane.bubble("right", `order #${1022 + serverV} updated`);
      lane.setTag("left", "stale", "stale");
      lane.caption("The server has news. The browser won't know until its <b>next poll</b>.");
      await ctx.wait(rand(3200, 6000));
    }
  })();

  const client = (async () => {
    while (ctx.alive) {
      await lane.send(ctx, "ltr", "GET /orders", { ms: 700 });
      const sv = serverV;
      const changed = sv > clientV;
      await lane.send(ctx, "rtl", changed ? `200 · v${sv}` : "304 · no change", {
        cls: changed ? "ok" : "ghost",
        ms: 700,
      });
      requests += 1;
      if (changed) {
        const first = events.find((e) => e.v > clientV);
        const delay = first ? performance.now() - first.t : 0;
        delays.push(delay);
        clientV = sv;
        lane.setVer("left", clientV);
        lane.setTag("left", "fresh", "");
        lane.caption(`Found it — <b>${(delay / 1000).toFixed(1)} s</b> after it actually happened.`);
      } else {
        empty += 1;
        lane.caption("Nothing new. <b>That request was wasted.</b>");
      }
      lane.stat("req", String(requests));
      lane.stat("empty", `${Math.round((empty / requests) * 100)}<small>%</small>`);
      lane.stat("delay", secs(avg(delays)));
      await ctx.wait(1500);
    }
  })();

  await Promise.all([server, client]);
}

/* ───────────────────────── Long polling ───────────────────────── */

async function runLongPoll(lane, ctx) {
  lane.reset();
  let serverV = 1;
  let clientV = 1;
  let waiter = null;
  const events = [];
  const delays = [];
  let requests = 0;
  let timeouts = 0;
  lane.stat("delay", secs(0));

  const server = (async () => {
    await ctx.wait(2600);
    while (ctx.alive) {
      serverV += 1;
      events.push({ v: serverV, t: performance.now() });
      lane.setVer("right", serverV);
      lane.pulse("right");
      lane.bubble("right", `order #${1022 + serverV} updated`);
      if (waiter) waiter("event");
      else lane.setTag("left", "stale", "stale");
      await ctx.wait(rand(2600, 9000));
    }
  })();

  const client = (async () => {
    while (ctx.alive) {
      lane.caption("The browser asks — and the server <b>doesn't answer yet</b>.");
      const held = await lane.send(ctx, "ltr", "GET /changes?since=v" + clientV, { ms: 700, keep: true });
      requests += 1;
      lane.stat("req", String(requests));

      let reason = "event";
      if (serverV <= clientV) {
        held.classList.add("held");
        held.textContent = "waiting…";
        lane.caption("Request parked on the server. Holding it open until there's news…");
        reason = await Promise.race([
          new Promise((r) => (waiter = r)),
          ctx.wait(6500).then(() => "timeout"),
        ]);
        waiter = null;
      } else {
        lane.caption("An event happened <b>between</b> two requests — the <code>since</code> cursor catches it.");
      }
      held.remove();
      ctx.check();

      if (reason === "timeout" && serverV <= clientV) {
        await lane.send(ctx, "rtl", "204 · timeout", { cls: "ghost", ms: 700 });
        timeouts += 1;
        lane.stat("timeouts", String(timeouts));
        lane.caption("Timeout with nothing to say. Empty response — <b>ask again immediately</b>.");
      } else {
        const sv = serverV;
        await lane.send(ctx, "rtl", `200 · v${sv}`, { cls: "ok", ms: 700 });
        const first = events.find((e) => e.v > clientV);
        const delay = first ? performance.now() - first.t : 0;
        delays.push(delay);
        clientV = sv;
        lane.setVer("left", clientV);
        lane.setTag("left", "fresh", "");
        lane.stat("delay", secs(avg(delays)));
        lane.caption(`Answered the moment it happened — <b>${(delay / 1000).toFixed(1)} s</b>. Now: a brand-new request.`);
      }
      await ctx.wait(350);
    }
  })();

  await Promise.all([server, client]);
}

/* ───────────────────────── SSE ───────────────────────── */

async function runSse(lane, ctx) {
  lane.reset();
  let serverV = 0;
  let clientV = 0;
  let connections = 0;
  let delivered = 0;
  const delays = [];
  lane.setVer("left", "id 0");
  lane.setVer("right", "id 0");
  lane.stat("delay", `0<small>ms</small>`);

  lane.caption("One request: <code>Accept: text/event-stream</code>.");
  await ctx.wait(600);
  await lane.send(ctx, "ltr", "GET /stream", { ms: 700 });
  await lane.send(ctx, "rtl", "200 · event-stream", { cls: "ok", ms: 700 });
  connections += 1;
  lane.stat("conn", String(connections));
  lane.wire("open");
  lane.wireLabel("one HTTP response that never ends");
  lane.caption("The response stays open. <b>The server writes whenever it wants.</b>");

  const emit = async (missed = false) => {
    serverV += 1;
    const id = serverV;
    lane.setVer("right", `id ${id}`);
    lane.pulse("right");
    if (missed) {
      lane.bubble("right", `event ${id} · nobody listening`);
      return;
    }
    const t0 = performance.now();
    await lane.send(ctx, "rtl", `event · id ${id}`, { row: "mid", ms: 750 });
    delays.push(performance.now() - t0);
    clientV = id;
    delivered += 1;
    lane.setVer("left", `id ${clientV}`);
    lane.stat("events", String(delivered));
    lane.stat("delay", `${Math.round(avg(delays))}<small>ms</small>`);
  };

  for (let i = 0; i < 4; i++) {
    await ctx.wait(rand(900, 1800));
    await emit();
  }

  await ctx.wait(900);
  lane.wire("broken");
  lane.wireLabel("connection lost");
  lane.setTag("left", "reconnecting…", "bad");
  lane.caption("Network drop. EventSource waits <code>retry: 2000</code> and reconnects <b>on its own</b>.");
  await ctx.wait(1100);
  await emit(true);
  await ctx.wait(900);
  await emit(true);
  await ctx.wait(600);

  lane.caption("…and sends back the <b>last id it saw</b>.");
  await lane.send(ctx, "ltr", `GET · Last-Event-ID: ${clientV}`, { ms: 800 });
  connections += 1;
  lane.stat("conn", String(connections));
  await lane.send(ctx, "rtl", `replay ${clientV + 1}, ${clientV + 2}`, { cls: "ok", ms: 800 });
  clientV = serverV;
  delivered += 2;
  lane.stat("events", String(delivered));
  lane.setVer("left", `id ${clientV}`);
  lane.setTag("left", "fresh", "");
  lane.wire("open");
  lane.wireLabel("resumed — nothing lost");
  lane.caption("Missed events replayed. <b>You wrote zero reconnection code.</b>");

  for (let i = 0; i < 3; i++) {
    await ctx.wait(rand(1000, 1800));
    await emit();
  }
  await ctx.wait(1800);
}

/* ───────────────────────── WebSocket ───────────────────────── */

async function runWs(lane, ctx) {
  lane.reset();
  let up = 0;
  let down = 0;
  const delays = [];
  lane.setVer("left", "—");
  lane.setVer("right", "—");
  lane.setTag("left", "connecting", "stale");
  lane.stat("delay", `0<small>ms</small>`);

  const handshake = async (label) => {
    lane.caption(label);
    await lane.send(ctx, "ltr", "GET /ws · Upgrade: websocket", { ms: 800 });
    await lane.send(ctx, "rtl", "101 Switching Protocols", { cls: "ok", ms: 800 });
    lane.wire("open");
    lane.wireLabel("full duplex · one TCP connection");
    lane.setTag("left", "OPEN", "");
    lane.setVer("left", "ws");
    lane.setVer("right", "ws");
  };

  await ctx.wait(500);
  await handshake("Handshake: an ordinary HTTP request asking to <b>upgrade</b>.");
  lane.caption("It's not HTTP anymore. <b>Either side can send, any time.</b>");

  const upMsgs = ["typing…", "msg: on my way", "cursor 120,48", "ack #12", "typing…"];
  const downMsgs = ["msg: see you soon", "presence +1", "#1024 shipped", "typing…", "ack #7"];
  let running = true;

  const sender = (dir, list, counterKey) =>
    (async () => {
      let i = 0;
      while (running && ctx.alive) {
        await ctx.wait(rand(900, 2200));
        if (!running) break;
        const t0 = performance.now();
        await lane.send(ctx, dir, list[i++ % list.length], { ms: 650 });
        delays.push(performance.now() - t0);
        if (counterKey === "up") lane.stat("up", String(++up));
        else lane.stat("down", String(++down));
        lane.stat("delay", `${Math.round(avg(delays))}<small>ms</small>`);
      }
    })();

  const heartbeat = (async () => {
    while (running && ctx.alive) {
      await ctx.wait(3800);
      if (!running) break;
      await lane.send(ctx, "ltr", "ping", { row: "mid", cls: "ghost dim", ms: 600 });
      await lane.send(ctx, "rtl", "pong", { row: "mid", cls: "ghost dim", ms: 600 });
    }
  })();

  const tasks = [sender("ltr", upMsgs, "up"), sender("rtl", downMsgs, "down"), heartbeat];
  await ctx.wait(10000);
  running = false;
  await Promise.all(tasks);
  lane.wireEl.querySelectorAll(".pkt").forEach((p) => p.remove());

  lane.wire("broken");
  lane.wireLabel("close 1006 · no close frame");
  lane.setTag("left", "CLOSED", "bad");
  lane.caption("Close <code>1006</code>: the network just died. <b>Your code</b> must notice, back off, reconnect…");
  await ctx.wait(1400);
  lane.setTag("left", "retry in 1s", "stale");
  await ctx.wait(800);
  lane.setTag("left", "retry in 2s", "stale");
  await ctx.wait(1200);
  await handshake("…handshake again…");
  lane.caption("…and <b>resync</b> — the socket won't tell you what you missed.");
  await lane.send(ctx, "ltr", "GET /orders (resync)", { cls: "ghost", ms: 700 });
  await lane.send(ctx, "rtl", "200 · snapshot", { cls: "ok", ms: 700 });
  await ctx.wait(1800);
}

/* ───────────────────────── registry ───────────────────────── */

const SIMS = {
  http: {
    run: runHttp,
    opts: {
      title: "request / response",
      left: { kind: "browser", name: "Browser", url: "app.com/orders" },
      right: { kind: "server", name: "Server", url: "api" },
      stats: [
        { key: "req", label: "Requests" },
        { key: "stale", label: "Stale for", cls: "warn" },
        { key: "srv", label: "Push channel", initial: "none" },
      ],
    },
  },
  polling: {
    run: runPolling,
    opts: {
      title: "polling · every 1.5 s",
      left: { kind: "browser", name: "Browser", url: "app.com/orders" },
      right: { kind: "server", name: "Server", url: "api" },
      stats: [
        { key: "req", label: "Requests" },
        { key: "empty", label: "Empty responses", cls: "warn" },
        { key: "delay", label: "Avg delay" },
      ],
    },
  },
  longpoll: {
    run: runLongPoll,
    opts: {
      title: "long polling · timeout 6.5 s",
      left: { kind: "browser", name: "Browser", url: "app.com/orders" },
      right: { kind: "server", name: "Server", url: "api" },
      stats: [
        { key: "req", label: "Requests" },
        { key: "timeouts", label: "Timeouts" },
        { key: "delay", label: "Avg delay", cls: "good" },
      ],
    },
  },
  sse: {
    run: runSse,
    opts: {
      title: "server-sent events",
      left: { kind: "browser", name: "EventSource", url: "app.com/orders" },
      right: { kind: "server", name: "Server", url: "api/stream" },
      stats: [
        { key: "conn", label: "Connections" },
        { key: "events", label: "Events delivered", cls: "good" },
        { key: "delay", label: "Avg delay", cls: "good" },
      ],
    },
  },
  ws: {
    run: runWs,
    opts: {
      title: "websocket",
      left: { kind: "browser", name: "Browser", url: "app.com/chat" },
      right: { kind: "server", name: "Server", url: "wss://api" },
      stats: [
        { key: "up", label: "Sent ↑" },
        { key: "down", label: "Received ↓" },
        { key: "delay", label: "Avg delay", cls: "good" },
      ],
    },
  },
};

const running = new Map();

export function buildSims() {
  document.querySelectorAll("[data-sim]").forEach((root) => {
    const def = SIMS[root.dataset.sim];
    if (!def) return;
    root._lane = new Lane(root, def.opts);
    root._lane.reset();
  });
}

export function startSims(slide) {
  stopAll();
  slide.querySelectorAll("[data-sim]").forEach((root) => {
    const def = SIMS[root.dataset.sim];
    if (!def || !root._lane) return;
    const ctx = new Ctx();
    running.set(root, ctx);
    (async () => {
      while (ctx.alive) {
        try {
          await def.run(root._lane, ctx);
        } catch (err) {
          if (!(err instanceof Stopped)) console.error(err);
          return;
        }
      }
    })();
  });
  slide.querySelectorAll("[data-arch]").forEach((root) => startArch(root));
}

export function stopAll() {
  for (const [root, ctx] of running) {
    ctx.stop();
    root._lane?.reset();
  }
  running.clear();
  stopArch();
}

/* ───────────────────────── architecture flow ───────────────────────── */

const EDGES = [
  { from: "stripe", to: "backend", c: "--c-hook", label: "webhook" },
  { from: "user", to: "backend", c: "--c-http", label: "POST /checkout" },
  { from: "backend", to: "db", c: "--c-db", label: "write" },
  { from: "db", to: "rt", c: "--c-db", label: "WAL" },
  { from: "rt", to: "ui", c: "--c-db", label: "change event" },
  { from: "backend", to: "push", c: "--c-sse", label: "or: app push" },
  { from: "push", to: "ui", c: "--c-sse", label: "message" },
];

const ROUTES = [
  ["user", "backend"],
  ["stripe", "backend", "db", "rt", "ui"],
  ["stripe", "backend", "push", "ui"],
];

let archState = null;

function center(root, name) {
  const el = root.querySelector(`[data-n="${name}"]`);
  return {
    el,
    x: (parseFloat(el.style.left) / 100) * root.offsetWidth,
    y: (parseFloat(el.style.top) / 100) * root.offsetHeight,
  };
}

function curve(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dy) > Math.abs(dx)) {
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy / 2}, ${b.x} ${b.y - dy / 2}, ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} C ${a.x + dx / 2} ${a.y}, ${b.x - dx / 2} ${b.y}, ${b.x} ${b.y}`;
}

function drawArch(root) {
  const svg = root.querySelector("[data-arch-svg]");
  const w = root.offsetWidth;
  const h = root.offsetHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = "";
  root.querySelectorAll(".elabel, .packet").forEach((e) => e.remove());
  const css = getComputedStyle(document.documentElement);
  const paths = {};
  for (const e of EDGES) {
    const a = center(root, e.from);
    const b = center(root, e.to);
    const color = css.getPropertyValue(e.c).trim();
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", curve(a, b));
    p.setAttribute("stroke", color);
    p.setAttribute("stroke-opacity", "0.75");
    p.classList.add("flowing");
    svg.appendChild(p);
    paths[`${e.from}>${e.to}`] = { path: p, color };
    const mid = p.getPointAtLength(p.getTotalLength() / 2);
    const lbl = document.createElement("div");
    lbl.className = "elabel";
    lbl.textContent = e.label;
    lbl.style.left = `${mid.x}px`;
    lbl.style.top = `${mid.y}px`;
    lbl.style.borderColor = color;
    root.appendChild(lbl);
  }
  const packet = document.createElement("div");
  packet.className = "packet";
  root.appendChild(packet);
  return { paths, packet };
}

function travel(path, packet, color, ms, isAlive) {
  return new Promise((resolve) => {
    const len = path.getTotalLength();
    const start = performance.now();
    packet.style.background = color;
    packet.style.boxShadow = `0 0 22px 6px ${color}`;
    packet.style.opacity = "1";
    const step = (now) => {
      if (!isAlive()) return resolve(false);
      const t = Math.min(1, (now - start) / ms);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const pt = path.getPointAtLength(e * len);
      packet.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
      if (t < 1) requestAnimationFrame(step);
      else resolve(true);
    };
    requestAnimationFrame(step);
  });
}

function startArch(root) {
  stopArch();
  const state = { alive: true };
  archState = state;
  requestAnimationFrame(async () => {
    const { paths, packet } = drawArch(root);
    let r = 0;
    while (state.alive) {
      const route = ROUTES[r++ % ROUTES.length];
      for (let i = 0; i < route.length - 1 && state.alive; i++) {
        const edge = paths[`${route[i]}>${route[i + 1]}`];
        const ok = await travel(edge.path, packet, edge.color, 1100, () => state.alive);
        if (!ok) return;
        const node = root.querySelector(`[data-n="${route[i + 1]}"]`);
        node.classList.remove("lit");
        void node.offsetWidth;
        node.classList.add("lit");
      }
      packet.style.opacity = "0";
      await new Promise((res) => setTimeout(res, 700));
    }
  });
}

function stopArch() {
  if (archState) archState.alive = false;
  archState = null;
}
