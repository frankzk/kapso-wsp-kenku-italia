// Kapso function: create a REAL (firm) Shopify order in the Kenku Italia store.
//
// Runtime contract (see Kapso docs): Kapso wraps this file and calls
// handler(request, env). DO NOT use `export default`.
//
// This creates a firm order via POST /orders.json (not a draft). By default it
// reserves inventory (decrement_obeying_policy). It does NOT email the customer
// unless send_receipt is passed true. Payment is cash on delivery (contrassegno):
// the order is left financial_status "pending".
//
// Offers (3x2 / 5x3): these are NOT modeled as Shopify variants — each product has
// a single unit price. So the offer is applied as an ORDER-LEVEL fixed discount,
// computed SERVER-SIDE from the real variant price (never trust the caller/LLM to
// do money math):
//   offer "3x2" -> quantity forced to 3, pay for 2 (discount = 1 x unit price)
//   offer "5x3" -> quantity forced to 5, pay for 3 (discount = 2 x unit price)
//   offer "1"   -> no discount, quantity as given (default)
// Offer mode requires exactly one line item identified by variant_id.
//
// Deploy via the Kapso dashboard. Secrets (Secrets tab): SHOPIFY_STORE_DOMAIN,
// SHOPIFY_ITALIA_ADMIN_TOKEN, optional SHOPIFY_API_VERSION (default 2025-07).
//
// Input (direct invoke root, or agent tool under body.input):
//   {
//     "line_items": [ { "variant_id": 41377989886055, "quantity": 1 } ],
//     "offer": "3x2",                            // "1" | "3x2" | "5x3" (default "1")
//     "customer": { "id": 8947749126247 },       // or { email, phone, first_name, last_name }
//     "email": "buyer@example.com",
//     "shipping_address": { "first_name": "...", "last_name": "...", "address1": "...",
//                            "city": "...", "province": "...", "zip": "...", "country": "Italy",
//                            "phone": "..." },
//     "note": "Note per il corriere: ...",
//     "tags": "whatsapp",
//     "send_receipt": false
//   }

async function handler(request, env) {
  const cfg = readConfig(env);
  if (cfg.error) return json({ ok: false, error: cfg.error }, 200);

  const body = await request.json().catch(() => ({}));
  const input = resolveInput(body);
  const api = shopifyApi(cfg);

  // Validate line items.
  const lineItems = Array.isArray(input.line_items) ? input.line_items : [];
  if (lineItems.length === 0) {
    return json({ ok: false, error: "line_items is required and must be a non-empty array" }, 200);
  }
  for (const [i, li] of lineItems.entries()) {
    const hasVariant = li.variant_id !== undefined && li.variant_id !== null;
    const hasCustom = li.title && li.price !== undefined;
    if (!hasVariant && !hasCustom) {
      return json({ ok: false, error: `line_items[${i}] needs variant_id, or title+price` }, 200);
    }
    if (!li.quantity || li.quantity < 1) {
      return json({ ok: false, error: `line_items[${i}] needs quantity >= 1` }, 200);
    }
  }

  // Require a way to identify/attach the customer.
  const customerId = input.customer?.id;
  const email = input.email || input.customer?.email;
  if (!customerId && !email) {
    return json({ ok: false, error: "provide customer.id or an email to attach the order" }, 200);
  }

  const offer = normalizeOffer(input.offer);

  try {
    // Apply a quantity offer (3x2 / 5x3) as a server-computed fixed discount.
    let discountCodes = null;
    if (offer !== "1") {
      if (lineItems.length !== 1 || lineItems[0].variant_id == null) {
        return json({ ok: false, error: "offer 3x2/5x3 requires exactly one line item identified by variant_id" }, 200);
      }
      const spec = OFFERS[offer]; // { units, pay }
      lineItems[0].quantity = spec.units;

      const vr = await api.get(`/variants/${encodeURIComponent(lineItems[0].variant_id)}.json`);
      if (!vr.ok || !vr.body.variant) {
        return json({ ok: false, error: "could not read variant price for offer", shopify_status: vr.status, detail: vr.body }, 200);
      }
      const unitPrice = Number.parseFloat(vr.body.variant.price);
      if (!Number.isFinite(unitPrice)) {
        return json({ ok: false, error: "invalid variant price", detail: vr.body.variant.price }, 200);
      }
      const discount = (spec.units - spec.pay) * unitPrice;
      discountCodes = [{ code: offer.toUpperCase(), amount: discount.toFixed(2), type: "fixed_amount" }];
    }

    // Build the order payload.
    const order = {
      line_items: lineItems.map((li) => {
        if (li.variant_id !== undefined && li.variant_id !== null) {
          return { variant_id: li.variant_id, quantity: li.quantity };
        }
        return { title: li.title, price: String(li.price), quantity: li.quantity };
      }),
      financial_status: input.financial_status || "pending", // contrassegno -> pending
      inventory_behaviour: input.inventory_behaviour || "decrement_obeying_policy",
      send_receipt: input.send_receipt === true,
      send_fulfillment_receipt: input.send_fulfillment_receipt === true,
    };
    if (discountCodes) order.discount_codes = discountCodes;

    if (customerId) {
      order.customer = { id: customerId };
    } else {
      order.email = email;
      const c = input.customer || {};
      if (c.first_name || c.last_name || c.email || c.phone) {
        order.customer = { first_name: c.first_name, last_name: c.last_name, email: c.email || email, phone: c.phone };
      }
    }
    if (input.email && !order.email) order.email = input.email;
    if (input.shipping_address) order.shipping_address = input.shipping_address;
    if (input.billing_address) order.billing_address = input.billing_address;
    if (input.currency) order.currency = input.currency;
    if (input.note) order.note = input.note;
    if (input.tags) order.tags = input.tags;

    const r = await api.post("/orders.json", { order });
    if (!r.ok) {
      // 200 with ok:false — Kapso masks worker 5xx responses behind a generic 502.
      return json({ ok: false, error: "shopify rejected the order", shopify_status: r.status, detail: r.body }, 200);
    }
    return json({ ok: true, offer, order: slimOrder(r.body.order) }, 200);
  } catch (e) {
    return json({ ok: false, error: "unhandled", detail: String(e) }, 200);
  }
}

const OFFERS = {
  "1": { units: 1, pay: 1 },
  "3x2": { units: 3, pay: 2 },
  "5x3": { units: 5, pay: 3 },
};

function normalizeOffer(value) {
  const v = (value ?? "1").toString().trim().toLowerCase().replace("×", "x");
  return OFFERS[v] ? v : "1";
}

function slimOrder(o) {
  if (!o) return null;
  return {
    id: o.id,
    order_number: o.order_number,
    name: o.name,
    order_status_url: o.order_status_url,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    subtotal_price: o.subtotal_price,
    total_discounts: o.total_discounts,
    total_price: o.total_price,
    currency: o.currency,
    created_at: o.created_at,
    line_items: (o.line_items ?? []).map((li) => ({
      title: li.title,
      quantity: li.quantity,
      price: li.price,
      variant_id: li.variant_id,
    })),
  };
}

// ---- shared helpers (single-file worker) ----

function resolveInput(body) {
  if (body && typeof body.input === "object" && body.input !== null) return body.input;
  return body || {};
}

function pickEnv(env, name) {
  if (env && env[name] != null) return env[name];
  for (const k of Object.keys(env || {})) if (k.trim() === name) return env[k];
  return undefined;
}

function readConfig(env) {
  const domain = (pickEnv(env, "SHOPIFY_STORE_DOMAIN") || "").trim();
  const token = (pickEnv(env, "SHOPIFY_ITALIA_ADMIN_TOKEN") || "").trim();
  const version = (pickEnv(env, "SHOPIFY_API_VERSION") || "2025-07").trim();
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
    post: (path, requestBody) => call("POST", path, requestBody),
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
