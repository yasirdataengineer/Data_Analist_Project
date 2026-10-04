// Monitoring Progres: evaluasi & penugasan pekerjaan.
// Owner assigns work to a PIC; the PIC fills in percentage, result or obstacles, and latest photos;
// the owner reviews and decides Open or Closed.
const express = require('express');
const { notify } = require('../lib/telegram');
const { badRequest } = require('../lib/errors');

module.exports = ({ store, upload, config, need }) => {
  const router = express.Router();

  const userName = (id) => store.find('users', (u) => u.id === id)?.name || '-';
  const projectLabel = (id) => {
    const p = id && store.find('projects', (x) => x.id === id);
    return p ? `${p.code} — ${p.name}` : null;
  };
  const decorate = (a) => {
    const updates = store
      .filter('assignmentUpdates', (u) => u.assignmentId === a.id)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return {
      ...a,
      picName: userName(a.picId),
      projectName: projectLabel(a.projectId),
      updates,
      latestPhoto: updates.flatMap((u) => u.photos || [])[0] || null,
      lastUpdate: updates[0] || null,
    };
  };
  const visible = (req) =>
    store.filter('assignments', (a) => req.can('progress.viewAll') || a.picId === req.user.id);
  const isDone = (a) => a.status === 'closed' || a.progress >= 100;

  router.get('/', (req, res) => {
    const all = visible(req);
    const filter = ['open', 'done', 'all'].includes(req.query.f) ? req.query.f : 'open';
    const pic = req.can('progress.viewAll') ? req.query.pic || '' : '';
    const rows = all
      .filter((a) => (filter === 'all' ? true : filter === 'done' ? isDone(a) : !isDone(a)))
      .filter((a) => !pic || a.picId === pic)
      .map(decorate)
      .sort((a, b) => (b.lastUpdate?.createdAt || b.createdAt).localeCompare(a.lastUpdate?.createdAt || a.createdAt));
    const pics = [...new Set(all.map((a) => a.picId))].map((id) => ({ id, name: userName(id) }));
    res.render('progress/index', {
      rows,
      filter,
      pic,
      pics,
      stats: { needProgress: all.filter((a) => !isDone(a)).length, done: all.filter(isDone).length, pics: pics.length },
    });
  });

  router.get('/baru', need('progress.assign'), (req, res) => {
    res.render('progress/form', {
      projects: store.all('projects'),
      people: store.filter('users', (u) => u.active && ['karyawan', 'owner'].includes(u.role)),
    });
  });

  router.post('/', need('progress.assign'), (req, res) => {
    const { title, description, picId, projectId, dueDate } = req.body;
    if (!title?.trim()) throw badRequest('Judul pekerjaan wajib diisi.');
    const pic = store.find('users', (u) => u.id === picId && u.active);
    if (!pic) throw badRequest('Pilih PIC.');
    const a = store.insert('assignments', {
      title: title.trim(),
      description: (description || '').trim(),
      picId: pic.id,
      projectId: projectId || null,
      dueDate: dueDate || null,
      progress: 0,
      status: 'open',
      createdBy: req.user.id,
    });
    notify(config, pic.id, `📌 Penugasan baru dari ${req.user.name}:\n<b>${a.title}</b>${a.dueDate ? `\nTarget: ${a.dueDate}` : ''}`);
    res.redirect(`/progres/${a.id}?ok=Penugasan dibuat`);
  });

  const load = (req) => {
    const a = store.find('assignments', (x) => x.id === req.params.id);
    return a && (req.can('progress.viewAll') || a.picId === req.user.id) ? a : null;
  };

  router.get('/:id', (req, res, next) => {
    const a = load(req);
    if (!a) return next();
    const item = decorate(a);
    res.render('progress/show', {
      a: item,
      history: item.updates.map((u) => ({ ...u, authorName: userName(u.authorId) })),
      photos: item.updates.flatMap((u) => (u.photos || []).map((src) => ({ src, at: u.createdAt }))),
    });
  });

  router.post('/:id/update', upload.array('photos', 6), (req, res, next) => {
    const a = load(req);
    if (!a) return next();
    if (a.picId !== req.user.id) throw badRequest('Hanya PIC yang bisa mengisi progres.');
    if (a.status === 'closed') throw badRequest('Pekerjaan sudah Closed.');
    const progress = Math.round(Number(req.body.progress));
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw badRequest('Persentase harus 0–100.');
    const result = (req.body.result || '').trim();
    const issue = (req.body.issue || '').trim();
    if (!result && !issue) throw badRequest('Isi hasil atau kendala.');

    store.insert('assignmentUpdates', {
      assignmentId: a.id,
      kind: 'progress',
      authorId: req.user.id,
      from: a.progress,
      to: progress,
      result,
      issue,
      photos: (req.files || []).map((f) => `/uploads/${f.filename}`),
    });
    store.update('assignments', a.id, { progress });
    notify(
      config,
      config.notifyChatId,
      `📈 <b>${a.title}</b>: ${a.progress}% → ${progress}%\nPIC: ${req.user.name}${result ? `\nHasil: ${result}` : ''}${issue ? `\nKendala: ${issue}` : ''}`
    );
    res.redirect(`/progres/${a.id}?ok=Progres tersimpan`);
  });

  router.post('/:id/evaluasi', need('progress.assign'), (req, res, next) => {
    const a = load(req);
    if (!a) return next();
    const status = req.body.status;
    if (!['open', 'closed'].includes(status)) throw badRequest('Pilih Open atau Closed.');
    store.insert('assignmentUpdates', {
      assignmentId: a.id,
      kind: 'evaluation',
      authorId: req.user.id,
      status,
      note: (req.body.note || '').trim(),
      photos: [],
    });
    store.update('assignments', a.id, { status, evaluatedBy: req.user.id, evaluatedAt: new Date().toISOString() });
    notify(config, a.picId, `Evaluasi <b>${a.title}</b>: ${status === 'closed' ? '✅ Closed' : '🔁 Open'}${req.body.note ? `\n${req.body.note}` : ''}`);
    res.redirect(`/progres/${a.id}?ok=Evaluasi tersimpan`);
  });

  return router;
};
