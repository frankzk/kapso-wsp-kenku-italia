// Kapso function (agent tool): send an interactive WhatsApp message with reply
// buttons to the customer in the current conversation. Lets the sales agent offer
// tappable choices (e.g. "Confermo" / "Modifica indirizzo") instead of plain text —
// higher conversion. The customer's tap comes back to the agent as their next reply.
//
// Runtime contract: Kapso calls handler(request, env). No `export default`.
// As an agent tool, Kapso sends { input, execution_context, whatsapp_context, ... }.
//
// Sends via the Kapso WhatsApp proxy (Meta Cloud API format):
//   POST https://api.kapso.ai/meta/whatsapp/v23.0/{phone_number_id}/messages
// Requires an active 24h session (fine mid-conversation). Max 3 buttons, title <=20 chars.
//
// Secrets (Secrets tab):
//   KAPSO_API_KEY             this project's Kapso API key
//   WHATSAPP_PHONE_NUMBER_ID  the WhatsApp number id (default: 597907523413541 sandbox)
//   KAPSO_PROXY_BASE_URL      optional, default https://api.kapso.ai/meta/whatsapp
//   WHATSAPP_GRAPH_VERSION    optional, default v23.0
//
// Input (body.input):
//   {
//     "body_text": "Per la spedizione, dove sei?",
//     "buttons": [ { "id": "continentale", "title": "Italia" },
//                  { "id": "isole", "title": "Sardegna/Sicilia" } ],
//     "recipient": "39333...",   // optional; defaults to the current conversation contact
//     "header_text": "…",         // optional
//     "footer_text": "…"          // optional
//   }

async function handler(request, env) {
  const apiKey = env.KAPSO_API_KEY;
  const base = env.KAPSO_PROXY_BASE_URL || "https://api.kapso.ai/meta/whatsapp";
  const version = env.WHATSAPP_GRAPH_VERSION || "v23.0";
  if (!apiKey) return json({ ok: false, error: "missing KAPSO_API_KEY secret" }, 200);

  const body = await request.json().catch(() => ({}));
  const input = (body.input && typeof body.input === "object") ? body.input : body;

  const phoneNumberId = pickPhoneNumberId(body) || env.WHATSAPP_PHONE_NUMBER_ID;
  if (!phoneNumberId) return json({ ok: false, error: "no phone_number_id (set WHATSAPP_PHONE_NUMBER_ID or ensure conversation context)" }, 200);

  const bodyText = (input.body_text || input.text || "").toString().trim();
  if (!bodyText) return json({ ok: false, error: "body_text is required" }, 200);

  const rawButtons = Array.isArray(input.buttons) ? input.buttons : [];
  if (rawButtons.length < 1 || rawButtons.length > 3) {
    return json({ ok: false, error: "provide 1 to 3 buttons" }, 200);
  }
  const buttons = rawButtons.slice(0, 3).map((b, i) => {
    const title = (typeof b === "string" ? b : b.title || "").toString().slice(0, 20);
    const id = ((typeof b === "object" && b.id) ? b.id : slug(title) || `btn_${i}`).toString().slice(0, 200);
    return { type: "reply", reply: { id, title } };
  });
  if (buttons.some((b) => !b.reply.title)) {
    return json({ ok: false, error: "each button needs a title" }, 200);
  }

  const recipient = pickRecipient(input, body);
  if (!recipient) return json({ ok: false, error: "no recipient phone found" }, 200);

  const interactive = {
    type: "button",
    body: { text: bodyText },
    action: { buttons },
  };
  if (input.header_text) interactive.header = { type: "text", text: String(input.header_text).slice(0, 60) };
  if (input.footer_text) interactive.footer = { text: String(input.footer_text).slice(0, 60) };

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizePhone(recipient),
    type: "interactive",
    interactive,
  };

  try {
    const res = await fetch(`${base}/${version}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
    if (!res.ok) {
      return json({ ok: false, error: "send failed", status: res.status, detail: data }, 200);
    }
    const messageId = data?.messages?.[0]?.id ?? null;
    return json({ ok: true, message_id: messageId, to: payload.to }, 200);
  } catch (e) {
    return json({ ok: false, error: "unhandled", detail: String(e) }, 200);
  }
}

function pickPhoneNumberId(body) {
  const i = (body.input && typeof body.input === "object") ? body.input : {};
  const ec = body.execution_context || {};
  const ctx = ec.context || {};
  const wa = body.whatsapp_context || {};
  const conv = wa.conversation || {};
  return i.phone_number_id || ctx.phone_number_id || ctx.whatsapp_phone_number_id ||
         conv.phone_number_id || conv.whatsapp_phone_number_id || null;
}

function pickRecipient(input, body) {
  if (input.recipient) return input.recipient;
  const ec = body.execution_context || {};
  const ctx = ec.context || {};
  if (ctx.phone_number) return ctx.phone_number;
  const wa = body.whatsapp_context || {};
  const conv = wa.conversation || {};
  return conv.contact_phone_number || conv.phone_number || conv.contact?.phone_number || "";
}

function normalizePhone(p) {
  const digits = String(p).replace(/[^\d]/g, "");
  return digits;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
