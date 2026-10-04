// Minimal signed-cookie session holding only the Telegram user id.
const crypto = require('crypto');

const COOKIE = 'tjp_sid';

function sign(value, secret) {
  const mac = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

function unsign(signed, secret) {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const a = Buffer.from(sign(value, secret));
  const b = Buffer.from(signed);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? value : null;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSession(res, userId, secret) {
  // SameSite=None + Secure so the cookie survives inside Telegram's webview iframe.
  const secure = res.req.secure || res.req.headers['x-forwarded-proto'] === 'https';
  const attrs = ['Path=/', 'HttpOnly', 'Max-Age=604800', secure ? 'SameSite=None; Secure' : 'SameSite=Lax'];
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(sign(userId, secret))}; ${attrs.join('; ')}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
}

function getSessionUserId(req, secret) {
  return unsign(readCookie(req, COOKIE), secret);
}

module.exports = { setSession, clearSession, getSessionUserId };
