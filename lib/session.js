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

// 30 days, so the installed app (PWA) doesn't ask to log in every week.
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function cookieAttrs(req, maxAge) {
  // SameSite=None + Secure so the cookie survives inside Telegram's webview iframe.
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return ['Path=/', 'HttpOnly', `Max-Age=${maxAge}`, secure ? 'SameSite=None; Secure' : 'SameSite=Lax'].join('; ');
}

function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [].concat(prev || [], cookie));
}

function setSession(res, userId, secret) {
  appendCookie(res, `${COOKIE}=${encodeURIComponent(sign(userId, secret))}; ${cookieAttrs(res.req, SESSION_MAX_AGE)}`);
}

function clearSession(res) {
  appendCookie(res, `${COOKIE}=; Path=/; Max-Age=0`);
}

// Generic signed cookie helpers (used to bind a pending bot login to the browser that started it).
function setSignedCookie(res, name, value, secret, maxAge) {
  appendCookie(res, `${name}=${encodeURIComponent(sign(value, secret))}; ${cookieAttrs(res.req, maxAge)}`);
}

function getSignedCookie(req, name, secret) {
  return unsign(readCookie(req, name), secret);
}

function clearCookie(res, name) {
  appendCookie(res, `${name}=; Path=/; Max-Age=0`);
}

function getSessionUserId(req, secret) {
  return unsign(readCookie(req, COOKIE), secret);
}

module.exports = { setSession, clearSession, getSessionUserId, setSignedCookie, getSignedCookie, clearCookie };
