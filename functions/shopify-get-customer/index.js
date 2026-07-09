// Kapso function: look up a Shopify customer in the Kenku Italia store.
//
// Runtime contract (see Kapso docs): Kapso wraps this file and calls
// handler(request, env). DO NOT use `export default`.
//
// Deploy via the Kapso dashboard (Functions → New Function → paste this code).
// The CLI does not manage functions. Set secrets in the function's Secrets tab
// AFTER the first deploy:
//   SHOPIFY_STORE_DOMAIN        e.g. qz6zqy-se.myshopify.com
//   SHOPIFY_ITALIA_ADMIN_TOKEN  offline Admin API token (shpat_.../shpua_...)
//   SHOPIFY_API_VERSION         optional, default 2025-07
//
// Input (works both as a direct invoke and as an agent tool — agent tool args
// arrive under body.input):
//   { "email": "buyer@example.com" }        -> search by email
//   { "phone": "+39333..." }                 -> search by phone
//   { "customer_id": 1234567890 }            -> fetch by id
//   optional: { "include_orders": true, "orders_limit": 5 }

async function handler(request, env) {
  const cfg = readConfig(env);
  if (cfg.error) return json({ error: cfg.error }, 500);

  const body = await request.json().catch(() => ({}));
  const input = resolveInput(body);

  const api = shopifyApi(cfg);

  try {
    let customer = null;

    if (input.customer_id) {
      const r = await api.get(`/customers/${encodeURIComponent(input.customer_id)}.json`);
      if (r.status === 404) return json({ found: false }, 200);
      if (!r.ok) return json({ error: "shopify error", status: r.status, detail: r.body }, 502);
      customer = r.body.customer ?? null;
    } else {
      const query = buildSearchQuery(input);
      if (!query) return json({ error: "provide email, phone, or customer_id" }, 400);
      const r = await api.get(`/customers/search.json?query=${encodeURIComponent(query)}&limit=1`);
      if (!r.ok) return json({ error: "shopify error", status: r.status, detail: r.body }, 502);
      customer = r.body.customers?.[0] ?? null;
    }

    if (!customer) return json({ found: false }, 200);

    const result = { found: true, customer: slimCustomer(customer) };

    if (input.include_orders) {
      const limit = clampInt(input.orders_limit, 1, 50, 5);
      const r = await api.get(`/orders.json?customer_id=${customer.id}&status=any&limit=${limit}`);
      if (r.ok) result.orders = (r.body.orders ?? []).map(slimOrder);
    }

    return json(result, 200);
  } catch (e) {
    return json({ error: "unhandled", detail: String(e) }, 500);
  }
}

function buildSearchQuery(input) {
  if (input.email) return `email:${input.email}`;
  if (input.phone) return `phone:${input.phone}`;
  return null;
}

function slimCustomer(c) {
  return {
    id: c.id,
    email: c.email,
    phone: c.phone,
    first_name: c.first_name,
    last_name: c.last_name,
    orders_count: c.orders_count,
    total_spent: c.total_spent,
    currency: c.currency,
    tags: c.tags,
    verified_email: c.verified_email,
    default_address: c.default_address
      ? {
          address1: c.default_address.address1,
          city: c.default_address.city,
          zip: c.default_address.zip,
          province: c.default_address.province,
          country: c.default_address.country,
          phone: c.default_address.phone,
        }
      : null,
  };
}

function slimOrder(o) {
  return {
    id: o.id,
    order_number: o.order_number,
    name: o.name,
    created_at: o.created_at,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    total_price: o.total_price,
    currency: o.currency,
    line_items: (o.line_items ?? []).map((li) => ({
      title: li.title,
      quantity: li.quantity,
      price: li.price,
      variant_id: li.variant_id,
    })),
  };
}

// ---- shared helpers (duplicated per function; Kapso workers are single-file) ----

// Resolve caller input across invocation modes:
//   - agent function tool -> args live in body.input
//   - direct invoke / function node -> fields at the root
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

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
