// Kapso PUBLIC function: receives Shopify webhooks and emits Kapso project events.
//
// This bridges Shopify -> Kapso for the proactive flows:
//   orders/create      -> project event "order.created"
//   checkouts/create   -> project event "checkout.created"   (abandoned-cart source)
//   checkouts/update   -> project event "checkout.updated"
//
// Deploy with public_endpoint: true (Shopify calls it with no X-API-Key). Security
// is enforced by verifying Shopify's HMAC signature. Register the webhooks in
// Shopify pointing at this function's invoke URL.
//
// Runtime contract: Kapso calls handler(request, env). No `export default`.
// Secrets (Secrets tab):
//   SHOPIFY_WEBHOOK_SECRET  Shopify webhook signing secret (the app's API secret /
//                           shpss_..., used to verify X-Shopify-Hmac-Sha256)
//   KAPSO_API_KEY           this project's Kapso API key (to POST /platform/v1/events)
//   KAPSO_API_BASE_URL      optional, default https://api.kapso.ai

async function handler(request, env) {
  const secret = env.SHOPIFY_WEBHOOK_SECRET;
  const kapsoKey = env.KAPSO_API_KEY;
  const kapsoBase = env.KAPSO_API_BASE_URL || "https://api.kapso.ai";
  if (!secret || !kapsoKey) {
    return json({ ok: false, error: "missing SHOPIFY_WEBHOOK_SECRET or KAPSO_API_KEY secret" }, 200);
  }

  const raw = await request.text();
  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256") || "";
  const topic = request.headers.get("X-Shopify-Topic") || "";
  const shop = request.headers.get("X-Shopify-Shop-Domain") || "";

  const valid = await verifyShopifyHmac(raw, secret, hmacHeader);
  if (!valid) return json({ ok: false, error: "invalid hmac" }, 401);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid json" }, 200);
  }

  const mapping = {
    "orders/create": () => ({ name: "order.created", properties: orderProps(payload, shop) }),
    "checkouts/create": () => ({ name: "checkout.created", properties: checkoutProps(payload, shop) }),
    "checkouts/update": () => ({ name: "checkout.updated", properties: checkoutProps(payload, shop) }),
  };

  const build = mapping[topic];
  if (!build) {
    // Acknowledge unrelated topics so Shopify does not retry.
    return json({ ok: true, ignored: true, topic }, 200);
  }

  const event = build();
  const res = await fetch(`${kapsoBase}/platform/v1/events`, {
    method: "POST",
    headers: { "X-API-Key": kapsoKey, "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  const detail = await res.text();
  if (!res.ok) {
    return json({ ok: false, error: "failed to emit event", status: res.status, detail }, 200);
  }
  return json({ ok: true, emitted: event.name }, 200);
}

function orderProps(o, shop) {
  const c = o.customer || {};
  const ship = o.shipping_address || {};
  return {
    shop,
    order_id: String(o.id ?? ""),
    order_number: String(o.order_number ?? o.number ?? ""),
    name: o.name ?? "",
    total_price: String(o.total_price ?? ""),
    currency: o.currency ?? "",
    financial_status: o.financial_status ?? "",
    customer_name: `${c.first_name ?? ship.first_name ?? ""} ${c.last_name ?? ship.last_name ?? ""}`.trim(),
    customer_phone: c.phone || o.phone || ship.phone || "",
    email: o.email || c.email || "",
    tags: o.tags ?? "",
  };
}

function checkoutProps(c, shop) {
  const cust = c.customer || {};
  const lineTitles = (c.line_items || []).map((li) => `${li.quantity}x ${li.title}`).join(", ");
  return {
    shop,
    checkout_id: String(c.id ?? ""),
    token: c.token ?? "",
    abandoned_checkout_url: c.abandoned_checkout_url ?? "",
    total_price: String(c.total_price ?? ""),
    currency: c.currency ?? "",
    customer_name: `${cust.first_name ?? ""} ${cust.last_name ?? ""}`.trim(),
    customer_phone: c.phone || cust.phone || "",
    email: c.email || cust.email || "",
    line_items_summary: lineTitles.slice(0, 500),
    completed_at: c.completed_at ?? "",
  };
}

// Shopify signs the raw request body with HMAC-SHA256 (base64) using the app secret.
async function verifyShopifyHmac(rawBody, secret, provided) {
  if (!provided) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const computed = base64(new Uint8Array(sig));
  return timingSafeEqual(computed, provided);
}

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
