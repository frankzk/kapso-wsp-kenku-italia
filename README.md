# kapso-wsp-kenku-italia

Kapso (WhatsApp) × Shopify integration for the **Kenku Italia** project.

- Kapso project: `Kenku Italia` — `f5fe95e9-22d4-420f-80cd-5ec60609b10a`
- Shopify store (Italia): `qz6zqy-se.myshopify.com`
- Kapso auth in CI/agent sessions: `KAPSO_API_KEY` (Platform API). The project name
  only resolves via `kapso login` (`app.kapso.ai`), which some sandboxes block.

> ⚠️ **Do not confuse stores.** The Shopify MCP available in agent sessions is
> connected to **Kenku Perú**, a different store. Nothing here should read from or
> write to it. All Shopify access for this project targets the **Italia** store
> above, via its own Admin API credentials.

## Function deploys: root cause & how to deploy

**Root cause (confirmed): function deploys only work when the function is created by
a *user*, not by the bare `KAPSO_API_KEY`.** It is NOT a plan limitation — the
project is on Kapso Pro (Functions included) and a user-created function deploys and
invokes fine.

Side-by-side proof on this project (`f5fe95e9-…`):

| Function | Created via | `created_by_id` | Deploy result |
| --- | --- | --- | --- |
| `hello-world-test` | Dashboard (user) | `78f54a1c-…` | `deployed`, `/invoke` returns 200 |
| `diag-hello*` | `KAPSO_API_KEY` (raw Platform API / `kapso push`) | `null` | `status: error`, `endpoint_url: null` |

Every function created with the environment `KAPSO_API_KEY` lands with
`created_by_id: null` and the Kapso→Cloudflare deploy step fails with no error
surfaced by the Platform API (no error field; `kapso logs` only covers
external_api_log / webhook sources, not internal deploys).

**Implication:** `kapso push` from an API-key-only, `app.kapso.ai`-blocked sandbox
(like the agent session that built this repo) cannot deploy. Deploy from a
user-authenticated path instead:

- **Dashboard** (the supported path): `app.kapso.ai` → Kenku Italia → Functions →
  New Function → paste the code from this repo → deploy → then add secrets in the
  function's **Secrets** tab. Secrets live in the dashboard, never in git.

Per the Kapso docs, **the CLI does not manage functions yet** — `kapso push` is not
a deploy path for functions. The `functions/` dir here is the source of truth for the
**code**; you deploy it through the dashboard and set secrets there.

## Getting the Shopify Admin API token (works today, no Kapso deploy needed)

We use Shopify's OAuth (Authorization Code) flow, run **locally**, to mint an
*offline* Admin API access token. It uses an `http://localhost` redirect, so it
needs no public host and does not depend on the broken function deploy.

```bash
export SHOPIFY_API_KEY=<app client id>
export SHOPIFY_API_SECRET=<app client secret, shpss_...>
export SHOPIFY_STORE_DOMAIN=qz6zqy-se.myshopify.com
node scripts/shopify-oauth-local.mjs
```

In the Shopify app config, register:
- **App URL:** `http://localhost:3456`
- **Allowed redirection URL:** `http://localhost:3456/callback`

Open the URL the script prints (while logged into the Italia store), approve, and
the token appears in your terminal. Store it as `SHOPIFY_ITALIA_ADMIN_TOKEN` for
the business functions. Treat it like a password — never commit it.

## Business functions

Deploy these via the dashboard (paste `index.js`, deploy, then add secrets):

- **`shopify-get-customer`** — look up a customer by `email`, `phone`, or
  `customer_id`; optionally include recent orders. Read-only.
- **`shopify-create-order`** — create a **firm** order (`POST /orders.json`), reserving
  inventory by default. Does not email the customer unless `send_receipt: true`.
  Payment is contrassegno (COD) → order left `financial_status: pending`.
  Supports quantity offers via `offer: "1" | "3x2" | "5x3"`: since offers are not
  Shopify variants, the function forces the quantity and applies a **server-computed
  fixed discount** from the real variant price (3x2 → qty 3 pay 2; 5x3 → qty 5 pay 3),
  so money math never depends on the LLM. Offer mode needs one line item by variant_id.
- **`shopify-search-products`** — list/search active products with variants and prices
  for the agent to quote live.

Both take secrets `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ITALIA_ADMIN_TOKEN`, and optional
`SHOPIFY_API_VERSION` (default `2025-07`).

### Runtime contract (important)

Kapso wraps the file and calls `handler(request, env)` — **do not use `export
default`**. Caller input is read as JSON from the request body; as an **agent tool**
the arguments arrive under `body.input` (the functions handle both shapes). Secrets
are read from `env.SHOPIFY_*` and are set in the dashboard **Secrets** tab *after* the
first deploy.

## Layout

```
functions/
  shopify-get-customer/     # read a customer (+ recent orders)
  shopify-create-order/     # create a firm order
  shopify-oauth-callback/   # SUPERSEDED — token was minted locally; see scripts/ below
scripts/
  shopify-oauth-local.mjs   # local, dependency-free OAuth token minter (already used)
  shopify-verify.mjs        # read-only token smoke test
```

## Secrets

Kapso function secrets are set in the dashboard (function page → **Secrets** tab),
UPPERCASE, encrypted, exposed as `env.NAME`. Functions must be **deployed first**,
then secrets added. Never commit real tokens/secrets to this repo.

Verified: **`runtime_config` is NOT exposed to `env`.** Setting a value in
`runtime_config` via the API and redeploying does not make it appear on `env` — only
dashboard **Secrets** feed `env`. So the Shopify domain/token/version must be added in
the Secrets tab, per function. (Also: the raw Platform API blocks non-curl clients
with Cloudflare error 1010 — deploy scripts should use curl.)
