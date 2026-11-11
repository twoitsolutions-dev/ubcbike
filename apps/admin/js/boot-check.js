/* UBC Commerce Hub — boot guard (ES5, classic script).
 * Shows a readable message instead of a blank screen if the app cannot start:
 * unsupported browser, a script error, or a resource that failed to load. */
(function () {
  var shown = false;
  function show(title, detail) {
    if (shown) return;
    shown = true;
    var el = document.getElementById('app');
    if (!el) return;
    el.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'boot boot-error';
    var h = document.createElement('h1');
    h.textContent = title;
    var p = document.createElement('p');
    p.textContent = detail;
    var b = document.createElement('button');
    b.className = 'btn';
    b.textContent = 'Reload';
    b.onclick = function () { location.reload(); };
    box.appendChild(h); box.appendChild(p); box.appendChild(b);
    el.appendChild(box);
  }
  window.__ubcBootFail = show;
  var supportsModules = 'noModule' in document.createElement('script');
  if (!supportsModules) {
    document.addEventListener('DOMContentLoaded', function () {
      show('Browser not supported', 'Please update Safari / iOS or use a current Chrome, Edge or Firefox.');
    });
    return;
  }
  window.addEventListener('error', function (e) {
    if (window.__ubcReady) return;
    var target = e && e.target;
    if (target && (target.src || target.href)) {
      show('A file failed to load', String(target.src || target.href));
    } else {
      show('The app could not start', (e && e.message) ? e.message : 'Unknown error');
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    if (window.__ubcReady) return;
    show('The app could not start', String(e && e.reason && e.reason.message ? e.reason.message : e.reason));
  });
  setTimeout(function () {
    if (!window.__ubcReady) show('Still loading…', 'The app is taking too long to start. Check your connection and reload.');
  }, 12000);
})();
