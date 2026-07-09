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

- **Dashboard** (recommended): `app.kapso.ai` → Kenku Italia → Functions → New
  Function → paste the code from this repo, set `runtime_config` there, deploy.
  Bonus: secrets live in the dashboard, never in git.
- **`kapso login` + `kapso push`** from a machine that can reach `app.kapso.ai`
  (login mints a user-scoped project key, so `created_by_id` is set and deploy works).

This repo stays the source of truth for function **code**; deployment + secrets are
done through one of the user-authenticated paths above.

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
