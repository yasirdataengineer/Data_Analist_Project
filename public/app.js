// Client glue for running inside Telegram's Mini App webview.
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg && tg.initData) {
    tg.ready();
    tg.expand();
    document.documentElement.dataset.theme = tg.colorScheme === 'dark' ? 'dark' : 'light';
    try { tg.setHeaderColor('#1e2a3a'); } catch (e) {}

    const back = document.body.dataset.back;
    if (back) {
      tg.BackButton.show();
      tg.BackButton.onClick(() => { location.href = back; });
    } else {
      tg.BackButton.hide();
    }
  }

  const clock = document.querySelector('[data-clock]');
  if (clock) {
    const tick = () => {
      clock.textContent = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
    };
    tick();
    setInterval(tick, 15000);
  }

  // Attach the device location to check-in/out forms when the user allows it.
  document.querySelectorAll('form[data-geo]').forEach((form) => {
    const status = form.querySelector('[data-geo-status]');
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        form.lat.value = pos.coords.latitude;
        form.lng.value = pos.coords.longitude;
        form.accuracy.value = Math.round(pos.coords.accuracy);
        if (status) status.textContent = `Lokasi terekam (±${Math.round(pos.coords.accuracy)} m).`;
      },
      () => { if (status) status.textContent = 'Lokasi tidak diizinkan; absen tetap bisa dikirim.'; },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // Prevent double submits on slow mobile connections.
  document.querySelectorAll('form').forEach((form) => {
    form.addEventListener('submit', () => {
      const btn = form.querySelector('button');
      if (btn) setTimeout(() => { btn.disabled = true; }, 0);
    });
  });
})();
