// WhatsApp Cloud API webhook.
// Handles "MASUK <ref>" (log in to One Hub) and "HUBUNGKAN <ref>" (attach this number to an account),
// each confirmed with "Ya, ini saya" / "Bukan saya" buttons that show the code from the app screen.
// Replies here are free-form: they fall inside the 24h window the user opened by messaging us.
const express = require('express');
const wa = require('../lib/whatsapp');

const REQUEST_RE = /\b(MASUK|HUBUNGKAN)\s+([A-Z2-9]{8})\b/i;
const BUTTON_RE = /^lg:([yn]):([0-9a-f]{32})$/;

module.exports = ({ store, config, botLogins, afterLogin }) => {
  const router = express.Router();
  const cfg = config.whatsapp || {};
  const reply = (to, text) => wa.sendText(cfg, to, text).catch((e) => console.error('[whatsapp]', e.message));

  // Meta's one-time verification when the webhook URL is registered.
  router.get('/', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && cfg.verifyToken && req.query['hub.verify_token'] === cfg.verifyToken) {
      return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
    }
    res.sendStatus(403);
  });

  router.post('/', async (req, res) => {
    if (!cfg.enabled || !wa.verifySignature(cfg.appSecret, req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
    // Acknowledge first; Meta retries deliveries that take too long.
    res.sendStatus(200);
    for (const msg of wa.parseWebhook(req.body)) {
      try {
        if (msg.kind === 'text') await onText(msg);
        else if (msg.kind === 'button') await onButton(msg);
      } catch (err) {
        console.error('[whatsapp] webhook:', err.message);
      }
    }
  });

  async function onText(msg) {
    const m = REQUEST_RE.exec(msg.text);
    if (!m) {
      return reply(msg.from, 'Ini nomor notifikasi TJP-EJS One Hub. Untuk masuk, buka aplikasi One Hub lalu pilih "Masuk dengan WhatsApp".');
    }
    const kind = m[1].toUpperCase() === 'HUBUNGKAN' ? 'link' : 'login';
    const r = botLogins.getByRef(m[2].toUpperCase());
    if (!r || r.status !== 'pending' || r.purpose !== kind) {
      return reply(msg.from, 'Kode sudah kedaluwarsa atau sudah dipakai. Ulangi dari aplikasi One Hub.');
    }
    if (r.waFrom && r.waFrom !== msg.from) return reply(msg.from, 'Kode ini sudah dipakai dari nomor lain.');
    r.waFrom = msg.from;

    const action = kind === 'link' ? 'menghubungkan nomor WhatsApp ini ke akun One Hub' : 'masuk ke TJP-EJS One Hub';
    await wa.sendButtons(
      cfg,
      msg.from,
      `🔐 Permintaan ${action}.\n\nPastikan kode di layar aplikasi adalah *${r.code}*.\nJika Anda tidak sedang melakukannya, tekan "Bukan saya".`,
      [
        { id: `lg:y:${r.token}`, title: 'Ya, ini saya' },
        { id: `lg:n:${r.token}`, title: 'Bukan saya' },
      ]
    );
  }

  async function onButton(msg) {
    const m = BUTTON_RE.exec(msg.buttonId);
    if (!m) return;
    const r = botLogins.get(m[2]);
    // Only the number that sent the MASUK/HUBUNGKAN message can answer.
    if (!r || r.status !== 'pending' || r.waFrom !== msg.from) {
      return reply(msg.from, 'Permintaan sudah kedaluwarsa. Ulangi dari aplikasi One Hub.');
    }
    if (m[1] === 'n') {
      botLogins.resolve(r.token, false);
      return reply(msg.from, 'Permintaan ditolak. Tidak ada perubahan pada akun Anda.');
    }

    const phone = wa.normalizePhone(msg.from);
    const owner = store.find('users', (u) => u.phone === phone);

    if (r.purpose === 'link') {
      const target = store.find('users', (u) => u.id === r.userId);
      if (!target) return reply(msg.from, 'Akun tidak ditemukan.');
      if (owner && owner.id !== target.id) {
        botLogins.resolve(r.token, false);
        return reply(msg.from, 'Nomor ini sudah terhubung ke akun lain. Hubungi admin One Hub.');
      }
      store.update('users', target.id, { phone, notify: { ...(target.notify || {}), whatsapp: true } });
      botLogins.resolve(r.token, true, target.id);
      return reply(msg.from, `✅ WhatsApp terhubung ke akun ${target.name}. Notifikasi One Hub akan dikirim ke nomor ini.`);
    }

    // Login: an account that already owns this number, or a new pending account for it.
    let user = owner;
    const isNew = !user;
    if (isNew) {
      user = store.insert('users', {
        id: `wa:${phone}`,
        name: msg.name || `+${phone}`,
        username: null,
        phone,
        role: null,
        company: null,
        active: false,
        lastSeenAt: new Date().toISOString(),
      });
    } else {
      store.update('users', user.id, { lastSeenAt: new Date().toISOString() });
    }
    user = afterLogin(user, isNew);
    botLogins.resolve(r.token, true, user.id);
    return reply(
      msg.from,
      user.active ? '✅ Login berhasil. Silakan kembali ke aplikasi One Hub.' : '✅ Nomor terdaftar. Akses Anda menunggu persetujuan pemilik/admin One Hub.'
    );
  }

  return router;
};
