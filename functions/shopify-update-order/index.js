// Kapso function: update an existing Shopify order in the Kenku Italia store.
//
// Used by the order-confirmation flow when the customer picks "Modifica
// indirizzo/dati": collect the corrected data and update the order's shipping
// address / contact / note. Firm orders remain firm; this only edits fields.
//
// Runtime contract: Kapso calls handler(request, env). No `export default`.
// Secrets (Secrets tab): SHOPIFY_STORE_DOMAIN, SHOPIFY_ITALIA_ADMIN_TOKEN,
// optional SHOPIFY_API_VERSION (default 2025-07).
//
// Input (root, or body.input for agent tools):
//   {
//     "order_id": 7573102559335,                 // required (Shopify order id)
//     "shipping_address": { "first_name": "...", "last_name": "...", "address1": "...",
//                            "city": "...", "province": "...", "zip": "...",
//                            "country": "Italy", "phone": "..." },
//     "email": "buyer@example.com",
//     "phone": "+39...",
//     "note": "Note per il corriere aggiornate",
//     "tags": "whatsapp,confermato"
//   }

async function handler(request, env) {
  const cfg = readConfig(env);
  if (cfg.error) return json({ ok: false, error: cfg.error }, 200);

  const body = await request.json().catch(() => ({}));
  const input = resolveInput(body);

  const orderId = input.order_id;
  if (!orderId) return json({ ok: false, error: "order_id is required" }, 200);

  const order = { id: orderId };
  if (input.shipping_address) order.shipping_address = input.shipping_address;
  if (input.email) order.email = input.email;
  if (input.phone) order.phone = input.phone;
  if (input.note) order.note = input.note;
  if (input.tags) order.tags = input.tags;

  if (Object.keys(order).length === 1) {
    return json({ ok: false, error: "nothing to update: provide shipping_address, email, phone, note or tags" }, 200);
  }

  const api = shopifyApi(cfg);
  try {
    const r = await api.put(`/orders/${encodeURIComponent(orderId)}.json`, { order });
    if (!r.ok) {
      return json({ ok: false, error: "shopify rejected the update", shopify_status: r.status, detail: r.body }, 200);
    }
    return json({ ok: true, order: slimOrder(r.body.order) }, 200);
  } catch (e) {
    return json({ ok: false, error: "unhandled", detail: String(e) }, 200);
  }
}

function slimOrder(o) {
  if (!o) return null;
  return {
    id: o.id,
    order_number: o.order_number,
    name: o.name,
    financial_status: o.financial_status,
    total_price: o.total_price,
    currency: o.currency,
    shipping_address: o.shipping_address
      ? {
          name: `${o.shipping_address.first_name ?? ""} ${o.shipping_address.last_name ?? ""}`.trim(),
          address1: o.shipping_address.address1,
          city: o.shipping_address.city,
          province: o.shipping_address.province,
          zip: o.shipping_address.zip,
          country: o.shipping_address.country,
          phone: o.shipping_address.phone,
        }
      : null,
    tags: o.tags,
  };
}

// ---- shared helpers (single-file worker) ----

function resolveInput(body) {
  if (body && typeof body.input === "object" && body.input !== null) return body.input;
  return body || {};
}

function readConfig(env) {
  const domain = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ITALIA_ADMIN_TOKEN;
  const version = env.SHOPIFY_API_VERSION || "2025-07";
  if (!domain) return { error: "missing SHOPIFY_STORE_DOMAIN secret" };
  if (!token) return { error: "missing SHOPIFY_ITALIA_ADMIN_TOKEN secret" };
  return { domain, token, version };
}

function shopifyApi(cfg) {
  const base = `https://${cfg.domain}/admin/api/${cfg.version}`;
  const headers = { "X-Shopify-Access-Token": cfg.token, "Content-Type": "application/json" };
  async function call(method, path, requestBody) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  }
  return {
    get: (path) => call("GET", path),
    put: (path, requestBody) => call("PUT", path, requestBody),
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
