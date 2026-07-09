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

## Status / known blocker

**Kapso function deploys currently fail for this project.** Pushing any function —
including a trivial hello-world worker — leaves it at `status: error`. This blocks
the Kapso-hosted OAuth callback and the business functions alike.

Diagnosis performed against the raw Platform API (`api.kapso.ai/platform/v1`,
`X-API-Key`):

- `POST /functions` (hello-world) → `201`, `status: draft`. Function is created fine.
- `POST /functions/{id}/deploy` → `202 { status: deploying }`, then within ~1s
  `GET /functions/{id}` returns `status: error`.
- **No error detail is surfaced anywhere reachable:** the function object has no
  error field, `endpoint_url` stays `null`, and `kapso logs search --problems-only`
  for `deploy`/`error`/`cloudflare` returns 0 events (Rails log search only covers
  external_api_log / webhook sources, not the internal Kapso→Cloudflare deploy).
- **`public_endpoint: true` is silently downgraded to `false` on create** — a strong
  signal that public function hosting is gated/not entitled for this project.
- No plan/entitlement endpoint exists on the Platform API (all of `plan`,
  `subscription`, `entitlements`, `usage`, `billing`, … return `404`).

**Most likely cause: function hosting is not enabled on the current (free) plan.**
Kapso functions are hosted Cloudflare Workers (paid infra), the public-endpoint flag
is being refused, and the deploy fails server-side with no user-facing reason — all
consistent with an entitlement limit rather than a code bug. Not yet proven, because
the only place the real deploy error / plan status is visible is the dashboard.

To confirm definitively (both need `app.kapso.ai`, which some sandboxes block):
- `app.kapso.ai` → Kenku Italia → Functions → open the failed deploy for the error.
- `app.kapso.ai` → billing/plan, or Kapso pricing/support: does the current plan
  include Functions? If not, upgrade or use an alternative host (see below).

If functions stay unavailable, the WhatsApp↔Shopify logic can instead run on any
host reachable by a Kapso webhook/workflow (e.g. your own serverless endpoint),
using the same Shopify token; only the *hosting* changes, not the integration.

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

## Layout

```
functions/
  shopify-oauth-callback/   # PARKED Kapso worker (same OAuth flow, for when deploys work)
scripts/
  shopify-oauth-local.mjs   # ACTIVE: local, dependency-free OAuth token minter
```

## Secrets

There is no CLI secret store in Kapso — a function's only config channel is
`runtime_config` in `function.yaml`, which lives in the repo. Real secret values are
therefore kept as placeholders in committed files and injected locally only at
`kapso push` time. Never commit real tokens/secrets. (Note: the CLI decamelizes
`runtime_config` keys, so `shopifyApiKey` is stored/injected as `shopify_api_key`.)
