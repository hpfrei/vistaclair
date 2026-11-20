// Loads the add-on client modules (the platform's Apps tab, Horst tab, fleet
// panel ...). GET /api/addons/client-modules (owner-authed, src/addons.js
// getClientModules) returns [{ styles, scripts }]: each module's stylesheets
// are linked, then its scripts load one after another, in the declared order
// (the first defines what the later ones render through).
(function () {
  fetch('/api/addons/client-modules', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (mods) {
      (Array.isArray(mods) ? mods : []).forEach(function (mod) {
        (mod.styles || []).forEach(function (href) {
          var link = document.createElement('link');
          link.rel = 'stylesheet'; link.href = href;
          document.head.appendChild(link);
        });
        var scripts = mod.scripts || [];
        (function loadNext(i) {
          if (i >= scripts.length) return;
          var el = document.createElement('script');
          el.src = scripts[i];
          el.onload = function () { loadNext(i + 1); };
          document.body.appendChild(el);
        })(0);
      });
    })
    .catch(function () {});
})();
