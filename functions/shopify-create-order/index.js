// Kapso function: create a REAL (firm) Shopify order in the Kenku Italia store.
//
// Runtime contract (see Kapso docs): Kapso wraps this file and calls
// handler(request, env). DO NOT use `export default`.
//
// This creates a firm order via POST /orders.json (not a draft). By default it
// reserves inventory (decrement_obeying_policy). It does NOT email the customer
// unless send_receipt is passed true.
//
// Deploy via the Kapso dashboard (Functions → New Function → paste this code).
// Set secrets in the function's Secrets tab AFTER the first deploy:
//   SHOPIFY_STORE_DOMAIN        e.g. qz6zqy-se.myshopify.com
//   SHOPIFY_ITALIA_ADMIN_TOKEN  offline Admin API token (shpat_.../shpua_...)
//   SHOPIFY_API_VERSION         optional, default 2025-07
//
// Input (direct invoke root, or agent tool under body.input):
//   {
//     "line_items": [
//       { "variant_id": 1234567890, "quantity": 2 },
//       { "title": "Custom item", "price": "19.90", "quantity": 1 }
//     ],
//     "customer": { "id": 1234567890 },          // or { email, phone, first_name, last_name }
//     "email": "buyer@example.com",              // used if customer has no id
//     "shipping_address": { "address1": "...", "city": "...", "zip": "...",
//                            "country": "Italy", "first_name": "...", "last_name": "..." },
//     "financial_status": "pending",             // default "pending"
//     "note": "Pedido por WhatsApp",
//     "tags": "whatsapp",
//     "currency": "EUR",
//     "send_receipt": false,                     // email customer? default false
//     "inventory_behaviour": "decrement_obeying_policy"  // default; reserves stock
//   }

async function handler(request, env) {
  const cfg = readConfig(env);
  if (cfg.error) return json({ ok: false, error: cfg.error }, 200);

  const body = await request.json().catch(() => ({}));
  const input = resolveInput(body);


  // Validate line items.
  const lineItems = Array.isArray(input.line_items) ? input.line_items : [];
  if (lineItems.length === 0) {
    return json({ error: "line_items is required and must be a non-empty array" }, 400);
  }
  for (const [i, li] of lineItems.entries()) {
    const hasVariant = li.variant_id !== undefined && li.variant_id !== null;
    const hasCustom = li.title && li.price !== undefined;
    if (!hasVariant && !hasCustom) {
      return json({ error: `line_items[${i}] needs variant_id, or title+price` }, 400);
    }
    if (!li.quantity || li.quantity < 1) {
      return json({ error: `line_items[${i}] needs quantity >= 1` }, 400);
    }
  }

  // Require a way to identify/attach the customer.
  const customerId = input.customer?.id;
  const email = input.email || input.customer?.email;
  if (!customerId && !email) {
    return json({ error: "provide customer.id or an email to attach the order" }, 400);
  }

  // Build the order payload.
  const order = {
    line_items: lineItems.map((li) => {
      if (li.variant_id !== undefined && li.variant_id !== null) {
        return { variant_id: li.variant_id, quantity: li.quantity };
      }
      return { title: li.title, price: String(li.price), quantity: li.quantity };
    }),
    financial_status: input.financial_status || "pending",
    inventory_behaviour: input.inventory_behaviour || "decrement_obeying_policy",
    send_receipt: input.send_receipt === true,
    send_fulfillment_receipt: input.send_fulfillment_receipt === true,
  };

  if (customerId) {
    order.customer = { id: customerId };
  } else {
    order.email = email;
    const c = input.customer || {};
    if (c.first_name || c.last_name || c.email || c.phone) {
      order.customer = {
        first_name: c.first_name,
        last_name: c.last_name,
        email: c.email || email,
        phone: c.phone,
      };
    }
  }

  if (input.email && !order.email) order.email = input.email;
  if (input.shipping_address) order.shipping_address = input.shipping_address;
  if (input.billing_address) order.billing_address = input.billing_address;
  if (input.currency) order.currency = input.currency;
  if (input.note) order.note = input.note;
  if (input.tags) order.tags = input.tags;

  const api = shopifyApi(cfg);
  try {
    const r = await api.post("/orders.json", { order });
    if (!r.ok) {
      // Return 200 with ok:false — Kapso masks worker 5xx responses, which would
      // otherwise hide Shopify's real rejection detail behind a generic 502.
      return json({ ok: false, error: "shopify rejected the order", shopify_status: r.status, detail: r.body }, 200);
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
    order_status_url: o.order_status_url,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
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

// ---- shared helpers (duplicated per function; Kapso workers are single-file) ----

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
    post: (path, requestBody) => call("POST", path, requestBody),
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
