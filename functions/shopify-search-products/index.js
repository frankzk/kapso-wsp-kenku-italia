// Kapso function: list / search products (with variants) in the Kenku Italia store.
//
// Runtime contract: Kapso calls handler(request, env). No `export default`.
// Secrets (dashboard Secrets tab): SHOPIFY_STORE_DOMAIN, SHOPIFY_ITALIA_ADMIN_TOKEN,
// optional SHOPIFY_API_VERSION (default 2025-07).
//
// Input (root or body.input for agent tools):
//   {}                          -> list active products (up to `limit`, default 50)
//   { "query": "shilajit" }     -> case-insensitive filter on product title
//   { "limit": 100 }
//
// Returns: { ok, count, products: [{ id, title, status, variants: [
//   { id, title, price, sku, available, inventory_quantity } ] }] }

async function handler(request, env) {
  const cfg = readConfig(env);
  if (cfg.error) return json({ ok: false, error: cfg.error }, 200);

  const body = await request.json().catch(() => ({}));
  const input = resolveInput(body);
  const query = (input.query || "").toString().trim().toLowerCase();
  const limit = clampInt(input.limit, 1, 250, 50);

  const api = shopifyApi(cfg);
  try {
    const r = await api.get(`/products.json?limit=${limit}`);
    if (!r.ok) return json({ ok: false, error: "shopify error", shopify_status: r.status, detail: r.body }, 200);

    let products = (r.body.products ?? []).map(slimProduct);
    if (query) products = products.filter((p) => (p.title || "").toLowerCase().includes(query));

    return json({ ok: true, count: products.length, products }, 200);
  } catch (e) {
    return json({ ok: false, error: "unhandled", detail: String(e) }, 200);
  }
}

function slimProduct(p) {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    variants: (p.variants ?? []).map((v) => ({
      id: v.id,
      title: v.title,
      price: v.price,
      sku: v.sku,
      available: v.inventory_policy === "continue" || (v.inventory_quantity ?? 0) > 0,
      inventory_quantity: v.inventory_quantity,
    })),
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
  return { get: (path) => call("GET", path) };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
