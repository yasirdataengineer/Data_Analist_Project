// "Masuk dengan Telegram" for the installed app / browser, where Telegram's initData isn't available.
//
// 1. The browser asks for a login request: it gets a token for the bot deep link and a short code to
//    show on screen, and a signed cookie ties the request to that browser.
// 2. The user opens t.me/<bot>?start=login_<token>. The bot shows the code and asks "Ya, ini saya?".
//    Comparing the code stops someone from sending a victim their own link.
// 3. On confirmation the bot reports the Telegram user to the server; the browser's next poll logs in.
//
// Requests live in memory for a few minutes; a restart just means tapping the button again.
const crypto = require('crypto');

class BotLoginRequests {
  constructor({ ttlMs = 5 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.requests = new Map();
  }

  create() {
    this.sweep();
    const token = crypto.randomBytes(16).toString('hex');
    const browserSecret = crypto.randomBytes(16).toString('hex');
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    this.requests.set(token, { token, browserSecret, code, status: 'pending', user: null, expiresAt: Date.now() + this.ttlMs });
    return { token, code, browserSecret };
  }

  get(token) {
    const r = this.requests.get(token);
    if (!r) return null;
    if (Date.now() > r.expiresAt) {
      this.requests.delete(token);
      return null;
    }
    return r;
  }

  // Called by the bot once the Telegram user taps "Ya, ini saya" or "Bukan saya".
  resolve(token, approve, tgUser) {
    const r = this.get(token);
    if (!r || r.status !== 'pending') return null;
    r.status = approve ? 'confirmed' : 'denied';
    r.user = approve ? tgUser : null;
    return r;
  }

  // One-shot: a confirmed request can only be turned into a session once.
  consume(token, browserSecret) {
    const r = this.get(token);
    if (!r || r.browserSecret !== browserSecret) return null;
    if (r.status !== 'pending') this.requests.delete(token);
    return r;
  }

  sweep() {
    const now = Date.now();
    for (const [token, r] of this.requests) if (now > r.expiresAt) this.requests.delete(token);
  }
}

module.exports = { BotLoginRequests };
