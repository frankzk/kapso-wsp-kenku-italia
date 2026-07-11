// Kapso DECIDE-node function: has an abandoned checkout been recovered (turned into
// an order)? Used by the abandoned-cart workflow to stop reminders once the customer
// buys.
//
// Runtime contract: Kapso calls handler(request, env). No `export default`.
// As a decide node, Kapso sends { execution_context, available_edges, ... }. This
// function returns { next_edge, vars }. Edge labels expected: "recovered" | "pending".
//
// Secrets (Secrets tab): SHOPIFY_STORE_DOMAIN, SHOPIFY_ITALIA_ADMIN_TOKEN,
// optional SHOPIFY_API_VERSION (default 2025-07).

async function handler(request, env) {
  const cfg = readConfig(env);
  const body = await request.json().catch(() => ({}));

  const availableEdges = Array.isArray(body.available_edges) ? body.available_edges : ["recovered", "pending"];
  const RECOVERED = availableEdges.includes("recovered") ? "recovered" : availableEdges[0];
  const PENDING = availableEdges.includes("pending") ? "pending" : availableEdges[availableEdges.length - 1];

  if (cfg.error) {
    // Fail safe: if misconfigured, treat as pending so a reminder can still go out.
    return json({ next_edge: PENDING, vars: { recovered: false, error: cfg.error } });
  }

  const props = pickProps(body);
  const token = props.checkout_token || props.token || "";
  const phone = props.customer_phone || "";
  const email = props.email || "";

  const api = shopifyApi(cfg);
  try {
    // Scan recent orders and match by checkout token, else by phone/email.
    const r = await api.get(`/orders.json?status=any&limit=100`);
    let recovered = false;
    let matched = null;
    if (r.ok && Array.isArray(r.body.orders)) {
      matched = r.body.orders.find((o) => {
        if (token && (o.checkout_token === token || String(o.checkout_id || "") === String(token))) return true;
        const oPhone = o.phone || o.customer?.phone || o.shipping_address?.phone || "";
        if (phone && oPhone && normalizePhone(oPhone) === normalizePhone(phone)) return true;
        if (email && (o.email || o.customer?.email) && (o.email || o.customer?.email).toLowerCase() === email.toLowerCase()) return true;
        return false;
      });
      recovered = Boolean(matched);
    }
    return json({
      next_edge: recovered ? RECOVERED : PENDING,
      vars: { recovered, recovered_order_number: matched?.order_number ?? null },
    });
  } catch (e) {
    return json({ next_edge: PENDING, vars: { recovered: false, error: String(e) } });
  }
}

// Pull checkout properties from wherever Kapso placed them (project-event context,
// vars, agent-tool input, or root).
function pickProps(body) {
  const ec = body.execution_context || {};
  const fromEvent = ec.context?.event?.properties;
  if (fromEvent && typeof fromEvent === "object") return fromEvent;
  if (ec.vars && typeof ec.vars === "object" && Object.keys(ec.vars).length) return ec.vars;
  if (body.input && typeof body.input === "object") return body.input;
  return body || {};
}

function normalizePhone(p) {
  return String(p).replace(/[^\d]/g, "").replace(/^0+/, "");
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
  async function call(method, path) {
    const res = await fetch(`${base}${path}`, { method, headers });
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
