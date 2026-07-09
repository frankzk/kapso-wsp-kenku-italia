#!/usr/bin/env node
// Read-only smoke test for the Kenku Italia Shopify Admin API token.
//
// Confirms the offline access token minted by scripts/shopify-oauth-local.mjs
// actually works: it reads shop info, one customer, and one order. It performs
// NO writes (does not create orders) — it only proves read access and that the
// granted scopes resolve.
//
// Requirements: Node 18+ (built-in fetch — no npm install).
//
// Usage (CMD):
//   set SHOPIFY_STORE_DOMAIN=qz6zqy-se.myshopify.com
//   set SHOPIFY_ITALIA_ADMIN_TOKEN=shpat_...        (or shpua_...)
//   node scripts\shopify-verify.mjs
//
// Usage (bash/PowerShell): export / $env: the same two variables, then run.

const SHOP = process.env.SHOPIFY_STORE_DOMAIN || "qz6zqy-se.myshopify.com";
const TOKEN = process.env.SHOPIFY_ITALIA_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";

if (!TOKEN) {
  console.error("Missing SHOPIFY_ITALIA_ADMIN_TOKEN. Set it to the token you minted, then re-run.");
  process.exit(1);
}

const base = `https://${SHOP}/admin/api/${API_VERSION}`;
const headers = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

async function get(path) {
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, scopes: res.headers.get("x-shopify-api-version"), body };
}

function line(label, value) {
  console.log(`  ${label.padEnd(16)} ${value}`);
}

(async () => {
  console.log(`\nShop:        ${SHOP}`);
  console.log(`API version: ${API_VERSION}\n`);

  // 1) Shop info — the simplest authenticated read.
  const shop = await get("/shop.json");
  if (!shop.ok) {
    console.error(`✗ /shop.json -> HTTP ${shop.status}`);
    console.error(JSON.stringify(shop.body, null, 2));
    console.error("\nToken is not valid for this store. Re-mint with shopify-oauth-local.mjs.");
    process.exit(1);
  }
  console.log("✓ Shop info");
  line("name", shop.body.shop?.name);
  line("email", shop.body.shop?.email);
  line("domain", shop.body.shop?.myshopify_domain);
  line("currency", shop.body.shop?.currency);
  line("country", shop.body.shop?.country_name);

  // 2) Read one customer (proves read_customers).
  const customers = await get("/customers.json?limit=1");
  console.log(`\n${customers.ok ? "✓" : "✗"} read_customers  (HTTP ${customers.status})`);
  if (customers.ok) {
    const c = customers.body.customers?.[0];
    line("count>=", (customers.body.customers?.length ?? 0).toString());
    if (c) line("sample", `${c.first_name ?? ""} ${c.last_name ?? ""} <${c.email ?? "no-email"}>`.trim());
    else line("sample", "(store has no customers yet)");
  } else {
    console.error(JSON.stringify(customers.body, null, 2));
  }

  // 3) Read one order (proves read_orders / read_all_orders).
  const orders = await get("/orders.json?limit=1&status=any");
  console.log(`\n${orders.ok ? "✓" : "✗"} read_orders     (HTTP ${orders.status})`);
  if (orders.ok) {
    const o = orders.body.orders?.[0];
    if (o) line("sample", `#${o.order_number} · ${o.total_price} ${o.currency} · ${o.financial_status}`);
    else line("sample", "(store has no orders yet)");
  } else {
    console.error(JSON.stringify(orders.body, null, 2));
  }

  console.log("\nDone. If all three are ✓, the token can read the Italia store.");
  console.log("Order *creation* (write) is exercised separately, once we build shopify-create-order.\n");
})();
