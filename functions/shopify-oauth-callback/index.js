// Shopify OAuth callback (one-time token minter) for the Kenku Italia store.
//
// Purpose: complete Shopify's Authorization Code (OAuth) flow so we obtain an
// *offline* Admin API access token. This function is only used a handful of
// times to mint / rotate that token; day-to-day API calls live in the business
// functions (shopify-get-customer, shopify-create-order), which use the token.
//
// Config comes from runtime_config (see function.yaml):
//   SHOPIFY_API_KEY     -> the app's Client ID
//   SHOPIFY_API_SECRET  -> the app's Client Secret (shpss_...)
//   SHOPIFY_STORE_DOMAIN-> qz6zqy-se.myshopify.com (used to validate the shop)
//
// Endpoints:
//   GET /?install=1  -> redirects the browser to Shopify's authorize screen
//   GET /?code=...   -> Shopify's redirect back; exchanges code -> token

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const params = url.searchParams;

    // The Kapso CLI decamelizes runtime_config keys, so read snake_case first,
    // then fall back to other casings to stay robust across CLI behavior.
    const apiKey = env.shopify_api_key ?? env.SHOPIFY_API_KEY ?? env.shopifyApiKey;
    const apiSecret = env.shopify_api_secret ?? env.SHOPIFY_API_SECRET ?? env.shopifyApiSecret;
    const expectedShop = env.shopify_store_domain ?? env.SHOPIFY_STORE_DOMAIN ?? env.shopifyStoreDomain;

    if (!apiKey || !apiSecret) {
      return json({ error: "missing SHOPIFY_API_KEY / SHOPIFY_API_SECRET in runtime_config" }, 500);
    }

    // Step 1: kick off the install — redirect to Shopify's authorize screen.
    if (params.get("install")) {
      const shop = params.get("shop") || expectedShop;
      if (!shop) return json({ error: "no shop configured" }, 400);
      const scopes = env.SHOPIFY_SCOPES ||
        "read_customers,write_customers,read_orders,write_orders,read_all_orders,read_draft_orders,write_draft_orders";
      const redirectUri = `${url.origin}${url.pathname}`;
      const state = crypto.randomUUID();
      const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
      authorize.searchParams.set("client_id", apiKey);
      authorize.searchParams.set("scope", scopes);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("state", state);
      // grant_options[]=  (blank) => offline (long-lived) token, which is what we want.
      return Response.redirect(authorize.toString(), 302);
    }

    // Step 2: the OAuth callback from Shopify.
    const code = params.get("code");
    const shop = params.get("shop");
    if (!code || !shop) {
      return json({ error: "missing code or shop; start with ?install=1" }, 400);
    }
    if (expectedShop && shop !== expectedShop) {
      return json({ error: `unexpected shop ${shop}` }, 401);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
      return json({ error: "invalid shop domain" }, 400);
    }

    // Verify Shopify's HMAC signature over the query string.
    const validHmac = await verifyHmac(params, apiSecret);
    if (!validHmac) {
      return json({ error: "invalid hmac" }, 401);
    }

    // Exchange the authorization code for an offline access token.
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    });

    if (!tokenResp.ok) {
      const detail = await tokenResp.text();
      return json({ error: "token exchange failed", status: tokenResp.status, detail }, 502);
    }

    const data = await tokenResp.json();
    // data = { access_token, scope }
    // NOTE: this is shown once. Copy access_token into the business functions'
    // runtime_config as SHOPIFY_ITALIA_ADMIN_TOKEN, then this callback can be deleted.
    return json({
      ok: true,
      shop,
      scope: data.scope,
      access_token: data.access_token,
      next: "Store access_token as SHOPIFY_ITALIA_ADMIN_TOKEN in the business functions.",
    }, 200);
  },
};

// Shopify signs the callback query string with HMAC-SHA256 using the app secret.
// The signature covers every query param except `hmac` (and legacy `signature`),
// sorted by key and joined as key=value pairs with `&`.
async function verifyHmac(params, secret) {
  const provided = params.get("hmac");
  if (!provided) return false;

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === "hmac" || key === "signature") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const message = pairs.join("&");

  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  const digest = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return timingSafeEqual(digest, provided);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
