// WhatsApp Business Platform (Cloud API) helpers.
// https://developers.facebook.com/docs/whatsapp/cloud-api
const crypto = require('crypto');

// Indonesian numbers: 0812… / +62 812… / 62812… -> 62812…
function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  else if (digits.startsWith('8')) digits = `62${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

function formatPhone(phone) {
  return phone ? `+${phone}` : '';
}

// Webhook payloads are signed with the Meta app secret (X-Hub-Signature-256: sha256=<hex>).
function verifySignature(appSecret, rawBody, header) {
  if (!appSecret || !rawBody || !header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function send(wa, payload) {
  const res = await fetch(`https://graph.facebook.com/${wa.apiVersion}/${wa.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${body.error?.message || 'unknown error'}`);
  return body;
}

// Free-form messages are only allowed inside the 24h window after the user messaged us.
function sendText(wa, to, text) {
  return send(wa, { to, type: 'text', text: { body: text.slice(0, 4096) } });
}

function sendButtons(wa, to, text, buttons) {
  return send(wa, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: text.slice(0, 1024) },
      action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  });
}

// Business-initiated messages (notifications) must use an approved template.
// Template parameters can't contain newlines, tabs or more than four spaces in a row.
function templateParam(text) {
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/[\r\n\t]+/g, ' · ')
    .replace(/ {4,}/g, '   ')
    .trim()
    .slice(0, 900);
}

function sendTemplate(wa, to, text) {
  return send(wa, {
    to,
    type: 'template',
    template: {
      name: wa.notifyTemplate,
      language: { code: wa.templateLang },
      components: [{ type: 'body', parameters: [{ type: 'text', text: templateParam(text) }] }],
    },
  });
}

// Pulls the messages we care about out of a webhook payload.
function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
      for (const m of value.messages || []) {
        const base = { from: m.from, name: names[m.from] || '', id: m.id };
        if (m.type === 'text') out.push({ ...base, kind: 'text', text: m.text?.body || '' });
        else if (m.type === 'interactive' && m.interactive?.type === 'button_reply') {
          out.push({ ...base, kind: 'button', buttonId: m.interactive.button_reply.id });
        } else if (m.type === 'button') out.push({ ...base, kind: 'button', buttonId: m.button?.payload || '' });
        else out.push({ ...base, kind: 'other' });
      }
    }
  }
  return out;
}

module.exports = { normalizePhone, formatPhone, verifySignature, sendText, sendButtons, sendTemplate, templateParam, parseWebhook };
