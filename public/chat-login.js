// Drives the "Masuk dengan Telegram / WhatsApp" and "Hubungkan WhatsApp" boxes:
// ask the server for a request, show the code + chat link, poll until the chat confirms.
(function () {
  const boxes = [...document.querySelectorAll('[data-chat-login]')];
  if (!boxes.length) return;
  let active = null;

  boxes.forEach((box) => {
    const channel = box.dataset.chatLogin;
    const purpose = box.dataset.purpose || 'login';
    const $ = (sel) => box.querySelector(sel);
    const step = (name) => box.querySelectorAll('[data-step]').forEach((el) => { el.hidden = el.dataset.step !== name; });
    let poll = null, countdown = null;

    const stop = () => { clearInterval(poll); clearInterval(countdown); poll = countdown = null; };
    const finish = (text) => { stop(); $('[data-message]').textContent = text; step('done'); };

    const check = async () => {
      try {
        const res = await fetch('/auth/bot/status', { cache: 'no-store' });
        const { status } = await res.json();
        if (status === 'confirmed') { stop(); location.replace('/'); }
        else if (status === 'linked') { stop(); location.replace('/profil?ok=' + encodeURIComponent('WhatsApp terhubung')); }
        else if (status === 'denied') finish('Permintaan ditolak dari chat.');
        else if (status === 'expired') finish('Waktu habis. Silakan coba lagi.');
      } catch (e) { /* offline for a moment; keep polling */ }
    };

    box.stop = stop;
    box.check = () => poll && check();

    $('[data-action="start"]').addEventListener('click', async (ev) => {
      // Only one request at a time: they share the same browser cookie.
      if (active && active !== box) { active.stop(); active.querySelectorAll('[data-step]').forEach((el) => { el.hidden = el.dataset.step !== 'start'; }); }
      active = box;
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const res = await fetch('/auth/bot/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, purpose }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal memulai.');
        $('[data-code]').textContent = data.code;
        $('[data-open]').href = data.link;
        step('wait');
        const deadline = Date.now() + data.expiresIn * 1000;
        const tick = () => {
          const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
          $('[data-timer]').textContent = `Berlaku ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        };
        tick();
        countdown = setInterval(tick, 1000);
        poll = setInterval(check, 2000);
      } catch (e) {
        finish(e.message);
      } finally {
        btn.disabled = false;
      }
    });
    $('[data-action="retry"]').addEventListener('click', () => { stop(); step('start'); });
  });

  // Coming back from the chat app: check right away instead of waiting for the next tick.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active) active.check(); });
})();
