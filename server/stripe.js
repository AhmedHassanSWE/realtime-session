import crypto from "node:crypto";

export const WEBHOOK_SECRET = "whsec_frontend_chapter_demo";
const TOLERANCE_SECONDS = 300;

function hmac(timestamp, body) {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
}

/** Mirrors the shape of Stripe's `Stripe-Signature` header: t=<unix>,v1=<hex hmac>. */
export function signPayload(body) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${hmac(t, body)}`;
}

export function verifySignature(rawBody, header) {
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const [k, ...v] = kv.split("=");
      return [k.trim(), v.join("=")];
    })
  );
  const t = Number(parts.t);
  if (!t || !parts.v1) return { ok: false, reason: "malformed signature header" };
  if (Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance (replay?)" };
  }
  const expected = Buffer.from(hmac(t, rawBody), "hex");
  const received = Buffer.from(parts.v1, "hex");
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

export function paymentSucceededEvent(order) {
  const rand = () => crypto.randomBytes(6).toString("hex");
  return {
    id: `evt_${rand()}`,
    type: "payment_intent.succeeded",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `pi_${rand()}`,
        amount: Math.round(order.total * 100),
        currency: "eur",
        metadata: { order_id: String(order.id) },
      },
    },
  };
}
