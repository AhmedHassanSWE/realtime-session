# Real-Time Web: Communication, Data & Events

A 60-minute Frontend Chapter session, from polling to WebSockets, real-time databases and webhooks. It comes with a live audience and a live demo.

Everything runs on your laptop: a Reveal.js deck, a Node server with real transports, a phone page for the audience, and a real-time order dashboard.

## Quick start

```bash
npm install
npm start
```

Requires Node 20+. The server prints three URLs:

| URL | What it is |
| --- | --- |
| `http://localhost:4173` | **The deck.** Present from this URL on the presenting laptop. |
| `http://localhost:4173/dashboard` | The live order dashboard (also embedded in the demo slide). |
| `http://<your-LAN-IP>:4173/join` | The audience page. Share this link with the room so phones can join (the server also serves a QR code for it at `/api/qr.svg`). |

Press **S** in the deck to open the speaker view with notes and timing cues (⏱). Press **F** for fullscreen and **Esc** for the overview.

> Presenter controls (slide sync, reset, dropping connections) only work from `localhost` on the machine running the server. Audience phones can react, vote and pay, and nothing else.

## What the audience experiences

1. **Slide 2:** the agenda. It flags the moments they'll use their phone.
2. **Slide 3:** they open the join link, their phone joins and they vote in the opening poll ("How does your browser know something changed?"). The phone counter and the bars update live, and reactions float across the screen.
3. **Demo, Act II:** every phone gets a "Pay" button. The first tap triggers a signed Stripe-style webhook that flips order #1023 to paid. Everyone else sees "someone was faster": idempotency, experienced first-hand.

The phone "stage" follows the slides automatically. Slides and fragments set it with `data-stage`.

## Demo script (47–55 min)

The dashboard lives on the demo slide (and at `/dashboard`). Press **Reset** before the talk.

**Act I: same UI, five transports (3 min)**
- Start on **Polling**. The **Kitchen** is already running (on at startup and after Reset), so an order changes every 10 s. Point at HTTP requests climbing and the 304 responses.
- **Long polling**: fewer requests, lower latency.
- **SSE**: one request, latency near zero.
- **WebSocket**: same numbers, but the log says `app pushed`.
- **Realtime DB**: the log says `change feed`. The backend never called broadcast.

**Act II: someone in the room pays (2 min)**
- Turn off the kitchen so the log is readable.
- Press → to put "Pay" on every phone. First tap wins.
- Narrate the log: Stripe → webhook → signature verified → UPDATE → change feed → UI.
- About 2 s later the duplicate delivery arrives and is ignored.
- Click **Forge webhook**. It's rejected with a signature mismatch.

**Act III: break the network (1.5 min)**
- Click **Drop connections**. Clients show "reconnecting", back off, reconnect, and refetch a snapshot.
- In polling mode there's nothing to drop, because polling is naturally resilient.

Press → again to send phones back to reactions.

**Connection limit:** browsers allow about 6 HTTP/1.1 connections per host, shared by every tab, and each SSE stream or held long poll uses one for as long as it's open. The deck's embedded dashboard therefore loads from `127.0.0.1` while the deck is on `localhost`, so it gets its own pool, and the speaker view doesn't run a copy. Avoid keeping several extra `/dashboard` tabs open while presenting. This is the same "~6 connections per domain" gotcha from the SSE slide, if anyone asks.

**Backup:** if the Wi-Fi dies, everything still runs on the laptop. Use the "Stripe: pay #1023" button instead of phones.

## If phones can't connect

Corporate and conference Wi-Fi often isolates clients, so phones can't reach your laptop's LAN IP. Put the server behind a tunnel and point the QR code at it:

```bash
# terminal 1
npx cloudflared tunnel --url http://localhost:4173   # or: ngrok http 4173

# terminal 2 — use the https URL the tunnel prints
PUBLIC_URL=https://your-tunnel.trycloudflare.com npm start
```

Keep presenting from `http://localhost:4173`. Requests that come through the tunnel are always treated as audience requests, even though the tunnel connects from localhost.

If nothing works, just continue. Every live widget has an offline fallback (show of hands), and the deck and dashboard work without phones.

## Timing

| Time | Chapter | Content |
| --- | --- | --- |
| 0–5 | Intro | Agenda, opening poll, examples, request/response vs event-driven, thesis, the map |
| 5–20 | Communication | Timeline, HTTP, polling, long polling, SSE, WebSockets (handshake, production concerns), comparison |
| 20–32 | Real-time data (Firestore) | The idea, app push vs DB push, `onSnapshot`, React hook, trade-offs |
| 32–42 | Webhooks | Why webhooks, "entrance not exit", the screen that waits for the webhook |
| 42–47 | Architecture | Animated end-to-end diagram, payment flow step by step |
| 47–55 | Live demo | Three acts on the order dashboard |
| 55–60 | Wrap-up | Ecosystem recap, takeaways, Q&A |

Two appendix slides (a reconnecting `useSocket` hook, and the demo's realtime client) come after Q&A for questions.

## How the demo works

| Mode | Transport | Server endpoint |
| --- | --- | --- |
| Polling | `fetch` every 2 s with `ETag` / `304` | `GET /api/orders` |
| Long polling | Held request, 10 s timeout → `204` | `GET /api/orders/changes?since=` |
| SSE | `EventSource` with `id:`, `retry:` and replay | `GET /api/orders/stream` |
| WebSocket | App-level push from route handlers | `ws://…/ws` |
| Realtime DB | `channel().on('postgres_changes').subscribe()` over a WebSocket, fed by the table's change feed | `ws://…/ws` (`realtime:subscribe`) |

The pace is configurable: `KITCHEN_MS=5000 npm start` changes an order every 5 s, and `LONG_POLL_TIMEOUT_MS` sets how long a long poll is held before the empty `204` (both default to 10 000 ms).

Webhooks are signed Stripe-style: HMAC-SHA256 of `timestamp.rawBody`, header `t=…,v1=…`, constant-time compare, 5-minute tolerance. The fake Stripe delivers every event twice to demonstrate idempotency.

## Project structure

```
server/
  server.js          HTTP + WebSocket server, audience, orders, webhooks, presenter controls
  db.js              In-memory orders table that emits a change event on every commit
  stripe.js          Webhook signing / verification
public/
  index.html         The deck (slides + speaker notes)
  css/deck.css       Design system
  js/deck.js         Reveal setup, chapter HUD, phone stages, title ticker
  js/live.js         Presenter WebSocket: counts, polls, reactions
  js/sims.js         Animated sequence-diagram simulations + architecture flow
  js/realtime-client.js   Supabase-shaped realtime client (~80 lines)
  dashboard/         Live order dashboard
  join/              Audience phone page (SSE down, fetch up)
scripts/
  screenshots.js     Renders every slide to .shots/ with headless Chrome
```

`npm run check` (with the server running) opens the dashboard in headless Chrome, clicks "Advance" in each of the five transport modes and prints PASS/FAIL. Run it once before the talk. `npm run check -- 3` does the same with three extra dashboards open, like a deck plus speaker view.

`npm run shots` (with the server running) re-renders every slide to `.shots/NN.png` for a visual check. Pass slide numbers to render only some, e.g. `npm run shots -- 11 12`.
