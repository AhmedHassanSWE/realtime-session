import { EventEmitter } from "node:events";

export const STATUSES = ["pending_payment", "preparing", "on_the_way", "delivered"];

const SEED = [
  { id: 1023, customer: "Nora K.", item: "2× Margherita", total: 24.9, payment: "pending", status: "pending_payment" },
  { id: 1024, customer: "James R.", item: "Pad Thai", total: 14.5, payment: "paid", status: "preparing" },
  { id: 1025, customer: "Amina S.", item: "Sushi set", total: 32.0, payment: "paid", status: "on_the_way" },
  { id: 1026, customer: "Omar F.", item: "Smash burger", total: 17.2, payment: "paid", status: "preparing" },
  { id: 1027, customer: "Lea M.", item: "Poke bowl", total: 13.8, payment: "paid", status: "delivered" },
];

const NEW_CUSTOMERS = [
  ["Yusuf A.", "Shawarma plate", 15.4],
  ["Sara L.", "Ramen", 16.9],
  ["Karim D.", "Falafel wrap", 9.8],
  ["Mia W.", "Caesar salad", 12.5],
  ["Hana T.", "Bibimbap", 15.0],
  ["Leo P.", "Pepperoni pizza", 13.9],
];

/**
 * A tiny in-memory "table" that behaves like a database with change data capture:
 * every committed write emits a change event, whether or not the caller remembers to broadcast.
 */
export class OrdersTable extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.rows = new Map(SEED.map((r) => [r.id, { ...r, updatedAt: Date.now() }]));
    this.version = (this.version ?? 0) + 1;
    this.changedAt = Date.now();
    this.nextId = 1028;
    this.customerCursor = 0;
    this.emit("reset");
  }

  all() {
    return [...this.rows.values()].sort((a, b) => a.id - b.id);
  }

  get(id) {
    return this.rows.get(Number(id));
  }

  snapshot() {
    return { version: this.version, changedAt: this.changedAt, orders: this.all() };
  }

  #commit(eventType, next, old) {
    this.version += 1;
    this.changedAt = Date.now();
    const change = {
      schema: "public",
      table: "orders",
      eventType,
      new: next ?? {},
      old: old ?? {},
      commit_timestamp: new Date(this.changedAt).toISOString(),
      version: this.version,
    };
    this.emit("change", change);
    return change;
  }

  update(id, patch) {
    const old = this.get(id);
    if (!old) return null;
    const next = { ...old, ...patch, updatedAt: Date.now() };
    this.rows.set(old.id, next);
    this.#commit("UPDATE", next, old);
    return next;
  }

  insert() {
    const [customer, item, total] = NEW_CUSTOMERS[this.customerCursor % NEW_CUSTOMERS.length];
    this.customerCursor += 1;
    const row = {
      id: this.nextId++,
      customer,
      item,
      total,
      payment: "paid",
      status: "preparing",
      updatedAt: Date.now(),
    };
    this.rows.set(row.id, row);
    this.#commit("INSERT", row, null);
    return row;
  }

  delete(id) {
    const old = this.get(id);
    if (!old) return null;
    this.rows.delete(old.id);
    this.#commit("DELETE", null, { id: old.id });
    return old;
  }

  advance(id) {
    const order = this.get(id);
    if (!order || order.status === "pending_payment" || order.status === "delivered") return null;
    const next = STATUSES[STATUSES.indexOf(order.status) + 1];
    return this.update(order.id, { status: next });
  }
}
