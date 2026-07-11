// Kapso function: fetch a product's media (images + video) from the Kenku Italia
// store, so the sales agent can send them via the send_media tool. Never returns
// media as text links — the caller passes these URLs to send_media.
//
// Runtime contract: Kapso calls handler(request, env). No `export default`.
// Secrets (Secrets tab): SHOPIFY_STORE_DOMAIN, SHOPIFY_ITALIA_ADMIN_TOKEN,
// optional SHOPIFY_API_VERSION (default 2025-07).
//
// Input (root, or body.input for agent tools):
//   { "product_id": 7278956347495 }   // Shopify product id (from search_products)
//
// Returns: { ok, title, video, images: [url...] }
//   video = first product video URL (or null), images = up to 10 image URLs.

async function handler(request, env) {
  const cfg = readConfig(env);
  if (cfg.error) return json({ ok: false, error: cfg.error }, 200);

  const body = await request.json().catch(() => ({}));
  const input = resolveInput(body);
  const productId = input.product_id;
  if (!productId) return json({ ok: false, error: "product_id is required" }, 200);

  const gid = `gid://shopify/Product/${productId}`;
  const query = `query($id: ID!) {
    product(id: $id) {
      title
      featuredImage { url }
      images(first: 10) { nodes { url } }
      media(first: 15) {
        nodes {
          mediaContentType
          ... on Video { sources { url format } }
        }
      }
    }
  }`;

  try {
    const res = await fetch(`https://${cfg.domain}/admin/api/${cfg.version}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": cfg.token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id: gid } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.errors) {
      return json({ ok: false, error: "shopify graphql error", status: res.status, detail: data.errors || data }, 200);
    }
    const p = data.data?.product;
    if (!p) return json({ ok: false, found: false }, 200);

    const images = [];
    if (p.featuredImage?.url) images.push(p.featuredImage.url);
    for (const n of p.images?.nodes || []) {
      if (n.url && !images.includes(n.url)) images.push(n.url);
    }

    // Prefer an mp4 source for the first video.
    let video = null;
    for (const n of p.media?.nodes || []) {
      if (n.mediaContentType === "VIDEO" && Array.isArray(n.sources) && n.sources.length) {
        const mp4 = n.sources.find((s) => (s.format || "").toLowerCase() === "mp4") || n.sources[0];
        if (mp4?.url) { video = mp4.url; break; }
      }
    }

    return json({ ok: true, title: p.title, video, images: images.slice(0, 10) }, 200);
  } catch (e) {
    return json({ ok: false, error: "unhandled", detail: String(e) }, 200);
  }
}

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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
