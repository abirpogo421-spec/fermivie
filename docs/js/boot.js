// Runs in <head> before the page is first drawn (a classic script, so the strict CSP needs no inline script).
// 1. The Python server writes its saved settings into the page as a JSON data block
//    (<script type="application/json" id="pm-settings">, see server.py _index). Read it into
//    window.__PM_SETTINGS__; js/api.js takes its presence to mean "a Fermivie server sent this page".
// 2. Apply theme / density / tab layout from those settings, or from this browser's last copy, so the
//    first paint already has the right theme.
// 3. With no data block (GitHub Pages or any static copy) the app shell stays out of sight until the
//    library is open (api.ready() and js/web/setup.js remove data-pm-booting).
(function () {
  var d = document.documentElement, s = null;
  var block = document.getElementById("pm-settings");
  if (block) {
    try { s = JSON.parse(block.textContent || "null"); } catch (e) { s = null; }
    window.__PM_SETTINGS__ = s && typeof s === "object" ? s : null;
  } else {
    d.setAttribute("data-pm-booting", "");
    // never leave a blank page behind if a module fails to load
    setTimeout(function () { d.removeAttribute("data-pm-booting"); }, 8000);
  }
  try {
    var c = s || JSON.parse(localStorage.getItem("pm2:settings") || "null") || {};
    if (c.theme === "light" || c.theme === "dark") d.dataset.theme = c.theme;
    d.dataset.density = c.density === "compact" ? "compact" : "comfortable";
    d.dataset.tabs = c.tabs === "vertical" ? "vertical" : "horizontal";
  } catch (e) {}
})();
