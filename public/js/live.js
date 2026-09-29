/**
 * Presenter side of the live audience features.
 * The deck holds one WebSocket: it sends slide stages and receives audience count, reactions and votes.
 */

export function initLive({ readOnly }) {
  const root = document.documentElement;
  const polls = {};
  const revealed = new Set();
  let socket = null;
  let retry = 0;
  let currentStage = null;
  let lastCount = -1;

  const offline = () => root.classList.add("is-offline");
  const online = () => root.classList.remove("is-offline");

  if (location.protocol === "file:") {
    offline();
    return { setStage() {}, revealAnswer() {} };
  }

  fetch("/api/info")
    .then((r) => r.json())
    .then((info) => {
      online();
      setJoinUrl(info.joinUrl);
      document.querySelectorAll('[data-live="qr"]').forEach((img) => (img.src = `/api/qr.svg?t=${Date.now()}`));
      connect();
    })
    .catch(offline);

  function setJoinUrl(url) {
    const pretty = url.replace(/^https?:\/\//, "");
    document.querySelectorAll('[data-live="join-url"]').forEach((el) => (el.textContent = pretty));
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws?role=presenter`);
    socket.onopen = () => {
      retry = 0;
      online();
      if (currentStage && !readOnly) send({ type: "stage", stage: currentStage });
    };
    socket.onmessage = (e) => handle(JSON.parse(e.data));
    socket.onclose = () => {
      const delay = Math.min(10000, 500 * 2 ** retry++) * (0.5 + Math.random());
      setTimeout(connect, delay);
    };
  }

  function send(msg) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }

  function handle(msg) {
    if (msg.type === "audience") setCount(msg.count);
    if (msg.type === "reaction") spawnReaction(msg.emoji);
    if (msg.type === "info") setJoinUrl(msg.joinUrl);
    if (msg.type === "poll") {
      polls[msg.poll.id] = msg.poll;
      renderPoll(msg.poll.id);
    }
  }

  function setCount(n) {
    document.querySelectorAll('[data-live="count"]').forEach((el) => {
      el.textContent = String(n);
      if (n > lastCount && lastCount >= 0) {
        el.classList.remove("bump");
        void el.offsetWidth;
        el.classList.add("bump");
      }
    });
    const hud = document.querySelector('[data-live="hud-count"]');
    if (hud) {
      hud.textContent = `${n} connected`;
      hud.classList.toggle("hidden", n === 0);
    }
    lastCount = n;
  }

  const layer = document.querySelector("[data-reactions]");
  let onScreen = 0;

  function spawnReaction(emoji) {
    if (!layer || onScreen > 60) return;
    const el = document.createElement("span");
    el.textContent = emoji;
    el.style.left = `${62 + Math.random() * 34}%`;
    el.style.setProperty("--dx", `${Math.round(Math.random() * 160 - 80)}px`);
    el.style.fontSize = `${34 + Math.random() * 22}px`;
    layer.appendChild(el);
    onScreen += 1;
    el.addEventListener("animationend", () => {
      el.remove();
      onScreen -= 1;
    });
  }

  function renderPoll(id) {
    const poll = polls[id];
    if (!poll) return;
    const max = Math.max(1, ...poll.counts);
    document.querySelectorAll(`[data-poll="${id}"]`).forEach((container) => {
      const correct = container.dataset.correct !== undefined ? Number(container.dataset.correct) : -1;
      if (container.children.length !== poll.options.length) {
        container.innerHTML = poll.options
          .map((opt) => `<div class="poll-row"><div class="bar"></div><span class="opt">${opt}</span><span class="cnt">0</span></div>`)
          .join("");
      }
      [...container.children].forEach((row, i) => {
        const count = poll.counts[i];
        row.querySelector(".bar").style.width = `${(count / max) * 100}%`;
        row.querySelector(".cnt").textContent = String(count);
        row.classList.toggle("correct", revealed.has(id) && i === correct);
      });
    });
    document.querySelectorAll(`[data-poll-total="${id}"]`).forEach((el) => (el.textContent = String(poll.total)));
  }

  return {
    setStage(stage) {
      if (readOnly) return;
      const key = JSON.stringify(stage);
      if (key === JSON.stringify(currentStage)) return;
      currentStage = stage;
      send({ type: "stage", stage });
    },
    revealAnswer(id, on) {
      if (on) revealed.add(id);
      else revealed.delete(id);
      renderPoll(id);
    },
  };
}
