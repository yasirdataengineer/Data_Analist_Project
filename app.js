const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');

const { validateInitData, notify } = require('./lib/telegram');
const { setSession, clearSession, getSessionUserId } = require('./lib/session');
const { ROLES, can } = require('./lib/access');
const { badRequest } = require('./lib/errors');
const dates = require('./lib/dates');

const DEFAULT_PROC_TYPES = ['Operasional', 'Pembelian barang', 'Kebutuhan lainnya'];
const DEFAULT_PROC_CATEGORIES = [
  { name: 'Project', requiresProject: true },
  { name: 'Kantor', requiresProject: false },
  { name: 'Kendaraan', requiresProject: false },
  { name: 'Lainnya', requiresProject: false },
];

function seed(store) {
  if (!store.all('procTypes').length) DEFAULT_PROC_TYPES.forEach((name) => store.insert('procTypes', { name, active: true }));
  if (!store.all('procCategories').length) DEFAULT_PROC_CATEGORIES.forEach((c) => store.insert('procCategories', { ...c, active: true }));
}

function createApp(config, store) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', true);
  seed(store);

  fs.mkdirSync(config.uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf'),
  });

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/public', express.static(path.join(__dirname, 'public')));
  app.use('/uploads', express.static(config.uploadDir));

  // Owners listed in env are always active owners, so the first login can bootstrap everything else.
  const applyOwner = (user) => {
    if (user && config.ownerIds.includes(user.id) && (user.role !== 'owner' || !user.active)) {
      return store.update('users', user.id, { role: 'owner', active: true, company: user.company || 'TJP' });
    }
    return user;
  };

  app.use((req, res, next) => {
    const userId = getSessionUserId(req, config.sessionSecret);
    req.user = applyOwner(userId ? store.find('users', (u) => u.id === userId) : null);
    req.can = (perm) => can(req.user, perm);
    Object.assign(res.locals, {
      user: req.user,
      can: req.can,
      ROLES,
      appName: config.appName,
      d: dates,
      path: req.path,
      flash: req.query.ok || null,
    });
    next();
  });

  // --- Auth -----------------------------------------------------------------

  app.get('/login', (req, res) => res.render('login', { devLogin: config.devLogin }));

  const afterLogin = (user, isNew) => {
    user = applyOwner(user);
    if (isNew && !user.active) {
      const owners = store.filter('users', (u) => u.role === 'owner' && u.active);
      owners.forEach((o) => notify(config, o.id, `👤 ${user.name}${user.username ? ` (@${user.username})` : ''} membuka One Hub dan menunggu akses.`));
    }
    return user;
  };

  app.post('/auth/telegram', (req, res) => {
    const tgUser = validateInitData(req.body.initData, config.botToken);
    if (!tgUser) return res.status(401).json({ ok: false, error: 'initData tidak valid' });
    const isNew = !store.find('users', (u) => u.id === String(tgUser.id));
    const user = afterLogin(store.upsertUser(tgUser), isNew);
    setSession(res, user.id, config.sessionSecret);
    res.json({ ok: true });
  });

  // Local development without Telegram. Disabled unless DEV_LOGIN=1.
  app.post('/auth/dev', (req, res) => {
    if (!config.devLogin) return res.status(404).end();
    const id = (req.body.id || 'dev-1').trim();
    const isNew = !store.find('users', (u) => u.id === id);
    let user = store.upsertUser({ id, first_name: (req.body.name || 'Pak yasir').trim(), username: req.body.username || undefined });
    if (ROLES[req.body.role]) user = store.update('users', id, { role: req.body.role, active: true, company: req.body.company || 'TJP' });
    user = afterLogin(user, isNew);
    setSession(res, user.id, config.sessionSecret);
    res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    clearSession(res);
    res.redirect('/login');
  });

  app.use((req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!req.user.active) return res.status(403).render('pending');
    next();
  });

  // Route guard: router.get('/x', need('perm.a', 'perm.b'), ...) passes if the user has any of them.
  const need = (...perms) => (req, res, next) => {
    if (perms.some((p) => req.can(p))) return next();
    const err = badRequest('Anda tidak punya akses ke halaman ini.');
    err.status = 403;
    next(err);
  };

  // --- Hub ------------------------------------------------------------------

  app.get('/', (req, res) => res.render('hub'));

  const deps = { store, upload, config, need };
  app.use('/progres', need('progress.view'), require('./routes/progress')(deps));
  app.use('/absensi', need('attendance.self', 'attendance.report'), require('./routes/attendance')(deps));
  app.use('/payroll', need('payroll.self', 'payroll.manage'), require('./routes/payroll')(deps));
  app.use('/proc', need('proc.request', 'proc.viewAll'), require('./routes/procurement')(deps));
  app.use('/kas', need('kas.view'), require('./routes/cash')(deps));
  app.use('/pengguna', need('users.manage'), require('./routes/users')(deps));

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
