// Passwordless login for the installed app / browser, confirmed in a chat app (Telegram bot or WhatsApp).
//
// 1. The browser asks for a request: it gets a short code to show on screen, and a signed cookie ties
//    the request to that browser.
//    - Telegram: the user opens t.me/<bot>?start=login_<token>.
//    - WhatsApp: the user sends "MASUK <ref>" to the business number (wa.me link with the text filled in).
// 2. The chat shows the code and asks "Ya, ini saya?". Comparing the code stops someone from sending a
//    victim their own link.
// 3. On confirmation the server records which user it was; the browser's next poll logs in.
//
// The same mechanism links a WhatsApp number to an account that is already logged in (purpose "link").
// Requests live in memory for a few minutes; a restart just means tapping the button again.
const crypto = require('crypto');

// No 0/O/1/I so the reference survives being read aloud or retyped.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeRef = () => Array.from(crypto.randomBytes(8), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');

class BotLoginRequests {
  constructor({ ttlMs = 5 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.requests = new Map();
  }

  create({ purpose = 'login', userId = null } = {}) {
    this.sweep();
    const token = crypto.randomBytes(16).toString('hex');
    const browserSecret = crypto.randomBytes(16).toString('hex');
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const ref = makeRef();
    this.requests.set(token, {
      token, ref, browserSecret, code, purpose,
      // For "link": the account the number will be attached to. For "login": filled in on confirmation.
      userId,
      status: 'pending',
      waFrom: null,
      expiresAt: Date.now() + this.ttlMs,
    });
    return { token, ref, code, browserSecret };
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

  getByRef(ref) {
    for (const r of this.requests.values()) if (r.ref === ref) return this.get(r.token);
    return null;
  }

  // Called once the chat user taps "Ya, ini saya" or "Bukan saya".
  resolve(token, approve, userId = null) {
    const r = this.get(token);
    if (!r || r.status !== 'pending') return null;
    r.status = approve ? 'confirmed' : 'denied';
    if (approve && userId) r.userId = userId;
    return r;
  }

  // One-shot: a finished request can only be read (and turned into a session) once.
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
