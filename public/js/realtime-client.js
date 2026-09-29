/**
 * A Supabase-shaped realtime client built on one WebSocket.
 * channel(name).on('postgres_changes', filter, cb).subscribe(onStatus)
 */
export class RealtimeClient {
  #url;
  #socket = null;
  #channels = [];
  #retry = 0;
  #timer = null;
  #closed = false;
  #refs = new Map();
  #onConnection;

  constructor(url, { onConnection } = {}) {
    this.#url = url;
    this.#onConnection = onConnection ?? (() => {});
    this.#connect();
  }

  channel(name) {
    const handlers = [];
    const channel = {
      name,
      on: (type, filter, cb) => {
        handlers.push({ filter, cb });
        return channel;
      },
      subscribe: (onStatus) => {
        this.#channels.push({ handlers, onStatus: onStatus ?? (() => {}) });
        this.#join();
        return channel;
      },
    };
    return channel;
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#socket?.close(1000);
  }

  #connect() {
    this.#onConnection({ state: "connecting" });
    const socket = new WebSocket(this.#url);
    this.#socket = socket;

    socket.onopen = () => {
      this.#retry = 0;
      this.#onConnection({ state: "open" });
      this.#join();
    };

    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const entry = this.#refs.get(msg.ref);
      if (!entry) return;
      if (msg.type === "realtime:subscribed") entry.channel.onStatus("SUBSCRIBED");
      if (msg.type === "postgres_changes") entry.handler.cb(msg.payload, msg);
    };

    socket.onclose = () => {
      this.#refs.clear();
      for (const ch of this.#channels) ch.onStatus("CHANNEL_ERROR");
      if (this.#closed) return;
      const delay = Math.min(15000, 500 * 2 ** this.#retry++) * (0.5 + Math.random());
      this.#onConnection({ state: "reconnecting", delay });
      this.#timer = setTimeout(() => this.#connect(), delay);
    };
  }

  /** Sends a subscribe frame for every handler; re-run after each reconnect. */
  #join() {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    for (const channel of this.#channels) {
      for (const handler of channel.handlers) {
        if ([...this.#refs.values()].some((r) => r.handler === handler)) continue;
        const ref = Math.random().toString(36).slice(2, 10);
        this.#refs.set(ref, { channel, handler });
        this.#socket.send(JSON.stringify({ type: "realtime:subscribe", ref, filter: handler.filter }));
      }
    }
  }
}
