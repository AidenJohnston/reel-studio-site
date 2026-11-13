// The support dashboard's page and script (served by support-admin.ts). The page holds no report data: the
// script asks for the admin secret, keeps it in this tab's sessionStorage, and reads /admin/support/api/ with it.
// Everything the reporter typed is put on the page with textContent, never as HTML.
//
// (The script avoids backticks and "${" so it can live in this template string as is.)

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Support reports</title>
<style>
:root{--bg:#fff;--fg:#141414;--muted:#666;--line:#e3e3e3;--soft:#f5f5f5;--accent:#0b57d0;--new:#b3261e;--triaged:#8a5a00;--fixed:#1e7a34;--wontfix:#555}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--muted:#9a9a9a;--line:#2c2c2c;--soft:#1e1e1e;--accent:#8ab4f8;--new:#f2b8b5;--triaged:#f0c674;--fixed:#7fd18b;--wontfix:#aaa}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:20px;margin:0 0 16px}
h2{font-size:16px;margin:24px 0 8px}
a{color:var(--accent)}
button,select,input,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
button{cursor:pointer;background:var(--soft)}
button.primary{background:var(--accent);color:var(--bg);border-color:var(--accent)}
button.danger{color:var(--new)}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px}
.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.03em}
tbody tr{cursor:pointer}
tbody tr:hover{background:var(--soft)}
.status{font-weight:600;white-space:nowrap}
.s-new{color:var(--new)}.s-triaged{color:var(--triaged)}.s-fixed{color:var(--fixed)}.s-wontfix{color:var(--wontfix)}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.text{white-space:pre-wrap;word-break:break-word;background:var(--soft);border-radius:8px;padding:10px 12px;margin:0}
pre.diag{white-space:pre-wrap;word-break:break-all;max-height:420px;overflow:auto}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}
dt{color:var(--muted)}
dd{margin:0;word-break:break-word}
img.shot{max-width:100%;border:1px solid var(--line);border-radius:8px}
.edit{display:grid;gap:8px;max-width:560px}
.edit textarea{min-height:80px}
.err{color:var(--new)}
[hidden]{display:none!important}
@media (max-width:640px){.hide-s{display:none}}
</style>
</head>
<body>
<main>
<h1>Support reports</h1>
<form id="login" class="bar" hidden>
  <label for="secret">Admin secret</label>
  <input id="secret" type="password" autocomplete="off" size="40" required>
  <button class="primary" type="submit">Open</button>
  <span class="muted">Kept in this tab only.</span>
</form>
<p id="msg" class="err" role="alert"></p>
<section id="list" hidden>
  <div class="bar">
    <label for="filter">Status</label>
    <select id="filter"><option value="">All</option><option value="new">New</option><option value="triaged">Triaged</option><option value="fixed">Fixed</option><option value="wontfix">Won't fix</option></select>
    <button id="reload" type="button">Reload</button>
    <button id="logout" type="button">Forget secret</button>
    <span id="count" class="muted"></span>
  </div>
  <table>
    <thead><tr><th>Id</th><th>When</th><th>Status</th><th>What happened</th><th class="hide-s">Version</th><th class="hide-s">OS</th><th class="hide-s">Key</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <p><button id="more" type="button" hidden>Load more</button></p>
</section>
<section id="one" hidden>
  <div class="bar"><a href="#" id="back">All reports</a></div>
  <h2 id="r-title"></h2>
  <dl id="r-facts"></dl>
  <h2>What happened</h2>
  <p id="r-what" class="text"></p>
  <div id="r-expected-box"><h2>What they expected</h2><p id="r-expected" class="text"></p></div>
  <h2>Status</h2>
  <form id="edit" class="edit">
    <select id="e-status"><option value="new">New</option><option value="triaged">Triaged</option><option value="fixed">Fixed in…</option><option value="wontfix">Won't fix</option></select>
    <input id="e-fixed" placeholder="Version it shipped in, e.g. 0.1.7" maxlength="40">
    <textarea id="e-note" placeholder="Internal note (never shown to the reporter)" maxlength="2000"></textarea>
    <div class="bar"><button class="primary" type="submit">Save</button><span id="e-msg" class="muted"></span></div>
  </form>
  <div id="r-shot-box"><h2>Screenshot</h2><img id="r-shot" class="shot" alt="Screenshot from the report"></div>
  <div id="r-diag-box"><h2>Diagnostics</h2><pre id="r-diag" class="text diag mono"></pre></div>
  <h2>Delete</h2>
  <p><button id="delete" class="danger" type="button">Delete this report now</button> <span class="muted">Reports are deleted automatically 180 days after they arrive.</span></p>
</section>
</main>
<script src="/admin/support/app.js"></script>
</body>
</html>
`

export const DASHBOARD_JS = `'use strict'
;(function () {
  var KEY = 'rs-support-secret'
  var $ = function (id) { return document.getElementById(id) }
  var secret = ''
  try { secret = sessionStorage.getItem(KEY) || '' } catch (e) {}
  var cursor = null
  var shotUrl = null
  var LABEL = { new: 'New', triaged: 'Triaged', fixed: 'Fixed', wontfix: "Won't fix" }

  function say(t) { $('msg').textContent = t || '' }
  function when(ms) { var d = new Date(ms); return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
  function statusText(s, fixedIn) { return s === 'fixed' && fixedIn ? 'Fixed in ' + fixedIn : (LABEL[s] || s) }
  function keyText(k) {
    if (!k || k.status === 'none') return 'none'
    if (k.status === 'invalid') return 'not ours'
    return (k.plan || '?') + (k.onFile === false ? ', not on file' : k.entitled === false ? ', ended (' + (k.reason || '') + ')' : ', entitled')
  }

  function api(path, opts) {
    opts = opts || {}
    var h = new Headers(opts.headers || {})
    h.set('Authorization', 'Bearer ' + secret)
    opts.headers = h
    return fetch('/admin/support/api/' + path, opts).then(function (r) {
      if (r.status === 401) { forget(); throw new Error('That secret was not accepted.') }
      return r
    })
  }
  function jsonOf(r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b && b.error ? b.error : 'HTTP ' + r.status); return b }) }

  function forget() {
    secret = ''
    try { sessionStorage.removeItem(KEY) } catch (e) {}
    show()
  }

  function show() {
    var ref = location.hash.slice(1)
    $('login').hidden = !!secret
    $('list').hidden = !secret || !!ref
    $('one').hidden = !secret || !ref
    if (!secret) { $('secret').focus(); return }
    if (ref) openReport(ref)
    else loadList(true)
  }

  function cell(tr, text, cls) { var td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; tr.appendChild(td); return td }

  function loadList(fresh) {
    say('')
    if (fresh) { cursor = null; $('rows').textContent = '' }
    var q = 'reports?status=' + encodeURIComponent($('filter').value) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
    api(q).then(jsonOf).then(function (b) {
      b.reports.forEach(function (r) {
        var tr = document.createElement('tr')
        tr.tabIndex = 0
        cell(tr, r.id, 'mono')
        cell(tr, when(r.created))
        cell(tr, statusText(r.status, r.fixedIn), 'status s-' + r.status)
        cell(tr, r.first + (r.shot ? '  [screenshot]' : ''))
        cell(tr, r.appVersion, 'hide-s')
        cell(tr, r.os, 'hide-s')
        cell(tr, r.plan || '', 'hide-s')
        var go = function () { location.hash = r.ref }
        tr.addEventListener('click', go)
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') go() })
        $('rows').appendChild(tr)
      })
      cursor = b.cursor
      $('more').hidden = !cursor
      $('count').textContent = $('rows').children.length + ' shown' + (cursor ? ', more below' : '')
    }).catch(function (e) { say(e.message) })
  }

  function fact(dl, k, v) {
    var dt = document.createElement('dt'); dt.textContent = k
    var dd = document.createElement('dd'); dd.textContent = v
    dl.appendChild(dt); dl.appendChild(dd)
  }

  function openReport(ref) {
    say('')
    if (shotUrl) { URL.revokeObjectURL(shotUrl); shotUrl = null }
    $('r-shot').removeAttribute('src')
    api('report?ref=' + encodeURIComponent(ref)).then(jsonOf).then(function (b) {
      var r = b.report
      $('r-title').textContent = r.id + ': ' + statusText(r.status, r.fixedIn)
      var dl = $('r-facts'); dl.textContent = ''
      fact(dl, 'Received', when(r.created))
      fact(dl, 'App', 'Reel Studio ' + r.appVersion)
      fact(dl, 'OS', r.os)
      fact(dl, 'Email', r.email || 'none given')
      fact(dl, 'Key', keyText(r.key))
      if (r.key && r.key.sid) fact(dl, 'Purchase', r.key.sid)
      fact(dl, 'Notice emailed', r.noticed ? 'yes' : 'no')
      if (r.updatedAt) fact(dl, 'Last changed', when(r.updatedAt))
      $('r-what').textContent = r.what
      $('r-expected').textContent = r.expected
      $('r-expected-box').hidden = !r.expected
      $('r-diag').textContent = r.diagnostics
      $('r-diag-box').hidden = !r.diagnostics
      $('e-status').value = r.status
      $('e-fixed').value = r.fixedIn || ''
      $('e-note').value = r.note || ''
      $('e-msg').textContent = ''
      syncFixed()
      $('edit').dataset.ref = r.ref
      $('delete').dataset.ref = r.ref
      $('r-shot-box').hidden = !r.screenshot
      if (r.screenshot) {
        api('screenshot?ref=' + encodeURIComponent(r.ref)).then(function (res) { if (!res.ok) throw new Error('screenshot: HTTP ' + res.status); return res.blob() }).then(function (blob) {
          shotUrl = URL.createObjectURL(blob)
          $('r-shot').src = shotUrl
        }).catch(function (e) { say(e.message) })
      }
    }).catch(function (e) { say(e.message) })
  }

  function syncFixed() { $('e-fixed').hidden = $('e-status').value !== 'fixed' }

  $('login').addEventListener('submit', function (e) {
    e.preventDefault()
    secret = $('secret').value.trim()
    $('secret').value = ''
    try { sessionStorage.setItem(KEY, secret) } catch (err) {}
    show()
  })
  $('logout').addEventListener('click', forget)
  $('reload').addEventListener('click', function () { loadList(true) })
  $('filter').addEventListener('change', function () { loadList(true) })
  $('more').addEventListener('click', function () { loadList(false) })
  $('back').addEventListener('click', function (e) { e.preventDefault(); location.hash = '' })
  $('e-status').addEventListener('change', syncFixed)
  $('edit').addEventListener('submit', function (e) {
    e.preventDefault()
    var ref = this.dataset.ref
    var body = { status: $('e-status').value, fixedIn: $('e-fixed').value, note: $('e-note').value }
    $('e-msg').textContent = 'Saving…'
    api('report?ref=' + encodeURIComponent(ref), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(jsonOf).then(function (b) {
      $('e-msg').textContent = 'Saved.'
      $('r-title').textContent = b.report.id + ': ' + statusText(b.report.status, b.report.fixedIn)
    }).catch(function (err) { $('e-msg').textContent = err.message })
  })
  $('delete').addEventListener('click', function () {
    var ref = this.dataset.ref
    if (!confirm('Delete this report and its screenshot? This cannot be undone.')) return
    api('report?ref=' + encodeURIComponent(ref), { method: 'DELETE' }).then(jsonOf).then(function () { location.hash = '' }).catch(function (e) { say(e.message) })
  })
  window.addEventListener('hashchange', show)
  show()
})()
`
