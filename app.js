const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');

const { validateInitData } = require('./lib/telegram');
const { setSession, clearSession, getSessionUserId } = require('./lib/session');
const dates = require('./lib/dates');

function createApp(config, store) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', true);

  fs.mkdirSync(config.uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
  });

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/public', express.static(path.join(__dirname, 'public')));
  app.use('/uploads', express.static(config.uploadDir));

  const isAdmin = (user) => !!user && config.adminIds.includes(user.id);

  app.use((req, res, next) => {
    const userId = getSessionUserId(req, config.sessionSecret);
    req.user = userId ? store.find('users', (u) => u.id === userId) : null;
    res.locals.user = req.user;
    res.locals.isAdmin = isAdmin(req.user);
    res.locals.appName = config.appName;
    res.locals.d = dates;
    res.locals.path = req.path;
    res.locals.flash = req.query.ok || null;
    next();
  });

  // --- Auth -----------------------------------------------------------------

  app.get('/login', (req, res) => res.render('login', { devLogin: config.devLogin }));

  app.post('/auth/telegram', (req, res) => {
    const tgUser = validateInitData(req.body.initData, config.botToken);
    if (!tgUser) return res.status(401).json({ ok: false, error: 'initData tidak valid' });
    const user = store.upsertUser(tgUser);
    setSession(res, user.id, config.sessionSecret);
    res.json({ ok: true });
  });

  // Local development without Telegram. Disabled unless DEV_LOGIN=1.
  app.post('/auth/dev', (req, res) => {
    if (!config.devLogin) return res.status(404).end();
    const name = (req.body.name || 'Pak yasir').trim();
    const user = store.upsertUser({ id: req.body.id || 'dev-1', first_name: name });
    setSession(res, user.id, config.sessionSecret);
    res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    clearSession(res);
    res.redirect('/login');
  });

  app.use((req, res, next) => (req.user ? next() : res.redirect('/login')));

  // --- Hub ------------------------------------------------------------------

  app.get('/', (req, res) => res.render('hub'));

  app.use('/progres', require('./routes/progress')({ store, upload, config, isAdmin }));
  app.use('/absensi', require('./routes/attendance')({ store, upload, config, isAdmin }));
  app.use('/payroll', require('./routes/payroll')({ store, config, isAdmin }));
  app.use('/proc', require('./routes/procurement')({ store, upload, config, isAdmin }));

  app.use((req, res) => res.status(404).render('error', { message: 'Halaman tidak ditemukan.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) Object.assign(err, { status: 400, expose: true, message: `Upload gagal: ${err.message}` });
    if (!err.expose) console.error(err);
    res.status(err.status || 500).render('error', { message: err.expose ? err.message : 'Terjadi kesalahan.' });
  });

  return app;
}

module.exports = { createApp };
