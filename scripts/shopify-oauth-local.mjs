#!/usr/bin/env node
// One-time, local Shopify OAuth token minter for the Kenku Italia store.
//
// Why this exists: the Kapso-hosted OAuth callback (functions/shopify-oauth-callback)
// cannot be used right now because function deploys fail for this project. This
// script does the exact same Authorization Code flow entirely on your machine,
// using an http://localhost redirect (Shopify allows localhost redirect URLs for
// development), so it needs no public host and no Kapso deploy.
//
// Result: it prints an *offline* Admin API access token (shpat_...). Store that as
// SHOPIFY_ITALIA_ADMIN_TOKEN for the business functions once deploys work again.
//
// Requirements: Node 18+ (uses built-in fetch/crypto/http — no npm install).
//
// Usage:
//   1) In the Shopify app config (dev dashboard) set:
//        App URL:                 http://localhost:3456
//        Allowed redirection URL: http://localhost:3456/callback
//      and make sure these scopes are granted (Admin API access scopes):
//        read_customers, write_customers, read_orders, write_orders,
//        read_all_orders, read_draft_orders, write_draft_orders
//   2) Export the app credentials (do NOT hard-code them):
//        export SHOPIFY_API_KEY=<client id>
//        export SHOPIFY_API_SECRET=<client secret, shpss_...>
//        export SHOPIFY_STORE_DOMAIN=qz6zqy-se.myshopify.com
//   3) Run:  node scripts/shopify-oauth-local.mjs
//   4) Open the printed URL in a browser where you're logged into the store,
//      approve, and the token appears in your terminal.

import http from "node:http";
import crypto from "node:crypto";

const SHOP = process.env.SHOPIFY_STORE_DOMAIN || "qz6zqy-se.myshopify.com";
const CLIENT_ID = process.env.SHOPIFY_API_KEY;
const CLIENT_SECRET = process.env.SHOPIFY_API_SECRET;
const SCOPES =
  process.env.SHOPIFY_SCOPES ||
  "read_customers,write_customers,read_orders,write_orders,read_all_orders,read_draft_orders,write_draft_orders";
const PORT = Number(process.env.PORT || 3456);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing SHOPIFY_API_KEY and/or SHOPIFY_API_SECRET.\n" +
      "  export SHOPIFY_API_KEY=<client id>\n" +
      "  export SHOPIFY_API_SECRET=<client secret, shpss_...>",
  );
  process.exit(1);
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(SHOP)) {
  console.error(`Invalid SHOPIFY_STORE_DOMAIN: ${SHOP}`);
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");
const authorizeUrl =
  `https://${SHOP}/admin/oauth/authorize` +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&state=${state}`;
// Leaving grant_options[] out => an offline (long-lived) token, which is what we want.

function verifyHmac(params, secret) {
  const provided = params.get("hmac");
  if (!provided) return false;
  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === "hmac" || key === "signature") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const message = pairs.join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not the callback. Open the authorize URL printed in the terminal.");
    return;
  }

  const params = url.searchParams;
  const finish = (code, msg) => {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(msg);
  };

  try {
    if (params.get("state") !== state) {
      finish(401, "State mismatch. Re-run the script.");
      console.error("\n✗ state mismatch — aborting.");
      return server.close(() => process.exit(1));
    }
    const shop = params.get("shop");
    const code = params.get("code");
    if (!code || !shop) {
      finish(400, "Missing code/shop.");
      return;
    }
    if (shop !== SHOP) {
      finish(401, `Unexpected shop ${shop}.`);
      console.error(`\n✗ unexpected shop ${shop} — aborting.`);
      return server.close(() => process.exit(1));
    }
    if (!verifyHmac(params, CLIENT_SECRET)) {
      finish(401, "Invalid HMAC.");
      console.error("\n✗ HMAC verification failed — aborting.");
      return server.close(() => process.exit(1));
    }

    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenResp.ok) {
      const detail = await tokenResp.text();
      finish(502, "Token exchange failed. See terminal.");
      console.error(`\n✗ token exchange failed (${tokenResp.status}):\n${detail}`);
      return server.close(() => process.exit(1));
    }

    const data = await tokenResp.json();
    finish(200, "✓ Token minted. Check your terminal, then close this tab.");
    console.log("\n✓ Offline Admin API access token for", shop);
    console.log("  scope:", data.scope);
    console.log("\n  access_token:\n  " + data.access_token + "\n");
    console.log("Store this as SHOPIFY_ITALIA_ADMIN_TOKEN for the business functions.");
    console.log("(Treat it like a password — do not commit it.)");
    server.close(() => process.exit(0));
  } catch (err) {
    finish(500, "Unexpected error. See terminal.");
    console.error("\n✗ error:", err);
    server.close(() => process.exit(1));
  }
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log("\nMake sure the app config has this exact redirect URL registered:");
  console.log(`  ${REDIRECT_URI}`);
  console.log("\nOpen this URL in a browser logged into the Kenku Italia store:\n");
  console.log("  " + authorizeUrl + "\n");
});
