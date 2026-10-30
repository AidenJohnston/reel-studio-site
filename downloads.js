// Shared by thanks.html and update.html: ask the download server for this buyer's links and show one
// "Download now" for the visitor's own system. No analytics; the only storage is the download code in
// this browser's localStorage so update.html can offer the newest version later without the email form.
var ReelDownloads = (function () {
  var API = window.REEL_DOWNLOADS_API || 'https://dl.getreelstudio.com'; // the override is for local testing only
  var KEY = 'reelstudio.download';

  function remembered() {
    try { return localStorage.getItem(KEY) || null; } catch (e) { return null; }
  }
  function remember(token) {
    try { localStorage.setItem(KEY, token); } catch (e) {}
  }
  function isMac() {
    return /Mac|iPhone|iPad/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);
  }
  function show(id, on) {
    var el = document.getElementById(id);
    if (el) el.hidden = !on;
  }
  function fail(html) {
    var s = document.getElementById('dl-status');
    if (s) { s.innerHTML = html; s.hidden = false; }
    show('dl-win', false); show('dl-mac', false);
  }

  /** Put the links on the page: the visitor's own system as the big button, the other as a small link. */
  function render(answer) {
    var mac = isMac();
    var win = document.getElementById('dl-win');
    var macBtn = document.getElementById('dl-mac');
    var alt = document.getElementById('dl-alt');
    var files = answer.files || {};
    if (files.win && win) win.href = files.win.url;
    if (files.mac && macBtn) macBtn.href = files.mac.url;
    var main = mac ? macBtn : win;
    var other = mac ? win : macBtn;
    var mainFile = mac ? files.mac : files.win;
    var otherFile = mac ? files.win : files.mac;
    show('dl-status', false);
    if (main && mainFile) {
      main.hidden = false;
      main.innerHTML = 'Download now<small>Reel Studio ' + answer.version + ' for ' + (mac ? 'Mac (Apple silicon, macOS 14+)' : 'Windows 10/11, 64-bit') + '</small>';
    }
    if (other) other.hidden = true;
    if (alt && otherFile) {
      alt.innerHTML = (mac ? 'On Windows instead? ' : 'On a Mac instead? ') + '<a href="' + otherFile.url + '">Download for ' + (mac ? 'Windows' : 'Mac') + '</a>.';
    }
    show('dl-help', true); show('dl-keep', true);
    if (answer.token) remember(answer.token);
  }

  /** query: "session_id=…" or "token=…". messages: what to say for an unpaid/unknown session or a busy server. */
  function claim(query, messages) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
    return fetch(API + '/api/claim?' + query, { signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (r.status === 402) throw 'unpaid';
        if (r.status === 404 || r.status === 400) throw 'unknown';
        if (r.status === 401) throw 'expired';
        if (!r.ok) throw 'busy';
        return r.json();
      })
      .then(function (a) { if (!a || !a.ok) throw 'busy'; render(a); return a; })
      .catch(function (why) {
        if (timer) clearTimeout(timer);
        if (why === 'expired') { try { localStorage.removeItem(KEY); } catch (e) {} }
        var key = why === 'unpaid' ? 'unpaid' : why === 'unknown' ? 'unknown' : why === 'expired' ? 'expired' : 'busy';
        fail(messages[key] || messages.busy);
        return null;
      });
  }

  /** "Email me my link". Resolves to the server's delivery mode: "email" (sent if we know the address) or "support". */
  function requestLink(email) {
    return fetch(API + '/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) })
      .then(function (r) { if (r.status === 400) throw 'bad'; if (r.status === 429) throw 'slow'; if (!r.ok) throw 'busy'; return r.json(); })
      .then(function (a) { return a.delivery || 'support'; });
  }

  return { remembered: remembered, claim: claim, requestLink: requestLink, fail: fail, isMac: isMac };
})();
