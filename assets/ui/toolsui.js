// The Tools tab: four tools and the approval switch as rows, and a screen for each tool. tools.js decides what the TV's answers
// mean; this file draws them and runs the steps. app.js keeps the focus and the dialog and hands them over in init().
// Strict CSP: no inline style or handlers. Shell output, package names and check names only go in through textContent.
(function () {
  const FAIL = "Couldn't read the details.", CHECKING = 'Checking…', NO_ANSWER = Tools.NO_ANSWER;
  const NOTE = 'Closed apps take longer to open next time.';
  const TILES = [['health', 'Nuvio health check'], ['memory', 'Free up memory'], ['network', 'Network check'], ['tidy', 'Restart and tidy']];
  // Health rows land as each check finishes; they are shown in this order so they don't jump about between runs.
  const KIND = { 'nuvio-app': 0, service: 1, yours: 2 };
  const BUILT_IN = ['Nuvio app', 'Nuvio sign-in', 'Nuvio sync', 'TorBox', 'TorBox (independent monitor)', 'Cinemeta (independent monitor)'];
  const DNS = { ok: 'OK', blocked: 'Pi-hole (or your ISP) is blocking it', failed: "can't be found" };
  const PKG = /^[A-Za-z0-9_.]+$/;

  let kit, view = 'home', expiry = null, expiryBusy = false, expiryNote = null;   // expiry: true once the approval never expires
  // apps: user apps, vpn: apps that provide a VPN (null until known: then nothing gets a Stop button), appsFail: why apps is null
  const mem = { info: null, apps: null, appsFail: FAIL, vpn: null, keep: [], busy: false, result: null };
  const tidy = { disk: null, busy: false, result: null, cleared: [] };   // cleared: see Tools.lessCleared
  let health = { running: false, rows: [], file: null, checks: [], error: null };
  let net = { running: false, answer: null };
  const waiting = new Tools.Waiters();
  const HEALTH_GAP = 45000;   // Java gives each health row up to 30 s (Health.ROW_MS); a longer silence means the TV stopped answering

  // ---- talking to Java ----

  /** The next answer to `name`, or {ok:false, error: NO_ANSWER} after `ms` (30 s unless given). Java runs tools one at a time,
   *  so each name's answers come back in the order asked; Tools.Waiters throws away a late one. */
  function expect(name, send, ms) {
    const p = waiting.wait(name, ms || 30000);
    send();
    return p;
  }
  const tool = (name, arg) => expect(name, () => TV.tool(name, arg == null ? null : arg));
  /** What a screen says when an answer failed: the no-answer text when the TV went quiet, else the usual line. */
  const why = r => r && r.error === NO_ANSWER ? NO_ANSWER : FAIL;
  const list = s => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : null; } catch (e) { return null; } };
  const self = () => kit.device().self || 'local.adam.tvtoolbox';
  const size = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB';

  // ---- drawing ----

  const el = (tag, cls, text) => kit.el(tag, cls, text);

  function draw(key) {
    kit.draw({ home, memory, keep: keepScreen, tidy: tidyScreen, health: healthScreen, network: networkScreen }[view](), key);
  }

  function heading(title, again, running, note) {
    const h = el('div', 'head');
    h.append(el('h2', null, title));
    if (again) { again.disabled = running; h.append(again); }
    if (running) h.append(el('p', 'note', note || CHECKING));
    return h;
  }

  function columns(a, b) {
    const s = el('div', 'split');
    s.append(a, b);
    return s;
  }

  function busyButton(text, key, fn, busy) {
    const b = kit.button(text, key, null, fn);
    b.disabled = busy;
    return b;
  }

  /** A row OK presses: a name, a quieter line under it, and a word at its end (On / Off for a switch). */
  function line(key, name, sub, word, fn) {
    const b = el('button', 'row tool f'), text = el('div', 'text');
    b.dataset.key = key;
    text.append(el('p', 'name', name));
    if (sub) text.append(el('p', 'blurb', sub));
    b.append(text);
    if (word) b.append(el('p', 'act', word));
    b.onclick = fn;
    return b;
  }

  function toggle(key, name, sub, on, fn) {
    const b = line(key, name, sub, on ? 'On' : 'Off', fn);
    b.classList.toggle('done', !on);
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', String(on));
    return b;
  }

  /** A one-line list row: the name (cut short with … when long), a quieter note, the amount; buttons go after it. */
  function row(name, amount, sub) {
    const r = el('div', 'row item');
    r.append(el('p', 'name', name));
    if (sub) r.append(el('p', 'sub', sub));
    r.append(el('p', 'size', amount));
    return r;
  }

  /** A box with a state mark. The mark's shape differs as well as its colour, so colour is never the only sign. */
  function mark(state, text) {
    const box = el('div', 'check ' + state), top = el('div', 'line');
    top.append(el('span', 'mark'), el('h3', 'name', text));
    box.append(top);
    return box;
  }

  function home() {
    const sw = toggle('expiry', 'Never expire USB debugging', expiryNote || (expiry ? null : 'Otherwise the TV asks again after 7 days.'), !!expiry, stopExpiry);
    sw.classList.add('apart');
    return TILES.map(t => line('tile:' + t[0], t[1], null, null, () => open(t[0]))).concat(sw);
  }

  function memory() {
    const m = mem.info, left = el('div'), right = el('div'), bar = el('div', 'bar');
    if (m && m.ok && m.total > 0) {
      const used = m.total - m.avail, g = el('progress', 'gauge');
      g.max = m.total;
      g.value = used;
      left.append(el('p', 'big', `${size(used)} of ${size(m.total)} in use`), g);
    }
    bar.append(busyButton('Close background apps', 'close', closeApps, mem.busy), kit.button('Never close', 'keep', null, () => open('keep')));
    left.append(bar);
    if (mem.result) left.append(el('p', 'big', mem.result));
    left.append(el('p', 'note', NOTE));
    right.append(el('h3', 'title', 'Using the most memory'));
    if (m) {
      const top = m.ok ? Tools.topMemory(m.text, 8) : [];
      if (!top.length) right.append(el('p', 'note', why(m)));
      top.forEach(p => {
        const pkg = p.name.split(':')[0], r = row(p.name, size(p.kb * 1024));
        // never a VPN app: stopping it drops the connection; nor any app while the VPN list is unknown
        const stoppable = mem.apps && mem.apps.includes(pkg) && pkg !== self() && mem.vpn && !mem.vpn.includes(pkg);
        if (stoppable) r.append(busyButton('Stop', 'stop:' + p.name, () => stopOne(pkg), mem.busy));
        right.append(r);
      });
    }
    return [heading('Free up memory', null, !m), columns(left, right)];   // meminfo takes ~8.5 s on a TV
  }

  function keepScreen() {
    const out = [heading('Never close', null, !mem.info)];
    if (!mem.info) return out;
    if (!mem.apps) return out.concat(el('p', 'note', mem.appsFail));
    const grid = el('div', 'grid two');
    mem.apps.filter(p => p !== self()).sort().forEach(p => {
      grid.append(toggle('keep:' + p, p, null, mem.keep.includes(p), () => setKeep(p)));
    });
    return out.concat(grid);
  }

  /** One column: package names need the width more than the two buttons need a column of their own. */
  function tidyScreen() {
    const d = tidy.disk, out = [heading('Restart and tidy', null, !d || tidy.busy)], top = el('div', 'actions'), bar = el('div', 'bar');
    bar.append(kit.button('Restart TV', 'restart', null, () => kit.ask('Restart the TV now?', 'Restart', () => tool('reboot'))),
               busyButton('Clear all app caches', 'trim', () => clean('trimCaches'), tidy.busy));
    top.append(bar);
    if (tidy.result) top.append(el('p', 'big', tidy.result));
    out.push(top);
    if (!d) return out;
    if (d.ok) out.push(el('p', 'big', `Free space: ${size(d.free)}`));
    out.push(el('h3', 'title', 'Biggest apps'));
    const apps = d.ok ? Tools.lessCleared(Tools.appSizes(d.text), tidy.cleared).slice(0, 6) : [], each = kit.device().sdk >= 34;
    if (!apps.length) out.push(el('p', 'note', why(d)));
    apps.forEach(a => {
      const cache = a.cache >= 1e6, r = row(a.pkg, size(a.total), cache ? 'Cache ' + size(a.cache) : null);
      if (each && cache) r.append(busyButton('Clear cache', 'cache:' + a.pkg, () => clean('clearCache', a.pkg), tidy.busy));
      out.push(r);
    });
    return out;
  }

  function healthScreen() {
    const order = BUILT_IN.concat(health.checks.map(c => c.name));
    const rank = r => (KIND[r.kind] !== undefined ? KIND[r.kind] : 3) * 1e3 + (order.indexOf(r.name) + 1 || 999);
    const grid = el('div', 'grid two');
    health.rows.slice().sort((a, b) => rank(a) - rank(b)).forEach(r => grid.append(checkRow(r)));
    if (health.file) grid.append(mark('grey', health.file === 'missing' ? 'Your checks file is missing.' : "Your checks file can't be read."));
    const out = [heading('Nuvio health check', kit.button('Check again', 'again', null, runHealth), health.running), grid];
    return health.error ? out.concat(el('p', 'note', health.error)) : out;
  }

  function checkRow(r) {
    const box = mark(Tools.rowState(r), r.name);
    // No time for the app row (nothing is fetched) or for no answer (the time is just the timeout; blame says "No answer").
    if (r.kind !== 'nuvio-app' && r.code !== 0 && r.ms > 0) box.firstChild.append(el('span', 'ms', `${Math.round(r.ms)} ms`));
    const aio = r.kind === 'yours' && health.checks.some(c => c.name === r.name && c.type === 'aiostreams') ? Tools.aioMessage(r.code) : null;
    [r.host, Tools.blame(r), aio, r.detail].forEach(t => { if (t) box.append(el('p', 'sub', t)); });   // Java sends the host, never the URL
    return box;
  }

  function networkScreen() {
    const out = [heading('Network check', kit.button('Check again', 'again', null, runNetwork), net.running, 'Checking, up to a minute…')], n = net.answer;
    if (net.running) return out;                     // nothing lands until it all has
    if (!n) return out;
    if (typeof n !== 'object' || n.ok === false) return out.concat(el('p', 'note', why(n)));
    if (n.error) return out.concat(el('p', 'note', 'The network check failed. Try again.'));   // the check broke, not the network
    const facts = el('div', 'facts'), dns = el('div');
    netLines(n).forEach(t => facts.append(el('p', null, t)));
    (Array.isArray(n.lookups) ? n.lookups : []).forEach(l => {
      const v = Tools.dnsVerdict(l.system, l.doh);
      dns.append(mark(v === 'ok' ? 'green' : 'red', `${l.host}: ${DNS[v]}`));
    });
    return out.concat(columns(facts, dns));
  }

  function netLines(n) {
    const ping = text => { const v = Tools.pingAvg(text); return v === null ? 'no answer' : (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ms'; };
    const w = n.wifi || {}, p = n.ping || {}, dns = n.privateDns || {};
    const wifi = 'Wi-Fi' + (w.mbps > 0 ? `, ${w.mbps} Mb/s` : '') + (w.rssi > -127 && w.rssi < 0 ? `, signal ${w.rssi} dBm` : '');   // -1 / -127: unknown
    return [
      'Connection: ' + (n.type === 'ethernet' ? 'Wired' : n.type === 'wifi' ? wifi : 'Other') + (n.vpn === true ? ', through a VPN' : ''),
      'Router ping: ' + ping(p.gateway),
      'Internet ping: ' + ping(p.internet),
      'Download speed: ' + (typeof n.speedMbps === 'number' ? Math.round(n.speedMbps) + ' Mb/s' : 'no answer'),
      'DNS servers: ' + (Array.isArray(n.dns) && n.dns.length ? n.dns.join(', ') : 'none found'),
      'Private DNS: ' + (dns.active ? 'on' + (dns.name ? ', ' + dns.name : '') : 'off'),
    ].concat(n.vpn === true ? "DNS comes from the VPN while it's on." : []);
  }

  // ---- what each screen does ----

  function open(id, key) {
    view = id;
    if (id === 'home') readExpiry();
    else if (id === 'memory') { mem.result = null; mem.info = null; loadKeep(); readMemory(); }   // no info: Checking…
    else if (id === 'tidy') { tidy.result = null; tidy.disk = null; tool('diskstats').then(d => { tidy.disk = d; draw(); }); }
    else if (id === 'health') runHealth();
    else if (id === 'network') runNetwork();
    draw(key || null);                               // null: the first thing on the new screen
  }

  async function readExpiry() {
    const r = await tool('expiryGet');
    expiry = !!r.ok && r.text === '0';
    expiryNote = r.ok ? null : why(r);
    draw();
  }

  async function stopExpiry() {
    if (expiryBusy || expiry) return;                 // nothing turns expiry back on: once On, OK does nothing, like an Installed row
    expiryBusy = true;
    try {
      const r = await tool('expiryOff');
      expiryNote = r.ok ? null : why(r);
      if (r.ok) await readExpiry(); else draw();
    } finally { expiryBusy = false; }
  }

  async function readMemory() {
    const a = await Promise.all([tool('meminfo'), tool('userApps'), tool('vpnApps')]);
    mem.info = a[0];
    mem.apps = a[1].ok ? Tools.parseUserApps(a[1].text) : null;
    mem.appsFail = why(a[1]);
    mem.vpn = a[2].ok && Array.isArray(a[2].apps) ? a[2].apps : null;
    draw();
  }

  /** The saved Never close list; the first time, the defaults: Nuvio, the home screen, TV Toolbox and the keyboard. */
  async function loadKeep() {
    const saved = list(TV.keepList());
    if (saved) return (mem.keep = saved);
    const a = await Promise.all([tool('home'), tool('ime')]);
    const pkg = r => { const p = r.ok ? String(r.text).split('/')[0] : ''; return PKG.test(p) ? [p] : []; };   // ime is pkg/.Service
    const want = ['com.nuvio.tv'].concat(pkg(a[0]), 'local.adam.tvtoolbox', pkg(a[1]));
    return (mem.keep = list(TV.setKeepList(JSON.stringify(want))) || want);
  }

  function setKeep(p) {
    const next = mem.keep.includes(p) ? mem.keep.filter(x => x !== p) : mem.keep.concat(p);
    mem.keep = list(TV.setKeepList(JSON.stringify(next))) || mem.keep;
    draw();
  }

  /** kill-all for the cached apps, then stop every user app not on the list, one after another. Never this app or a VPN app
   *  (stopping one drops the TV's connection), whatever the list says; when the VPN apps can't be read, nothing is stopped. */
  async function closeApps() {
    mem.busy = true;
    mem.result = null;
    draw();
    const keep = await loadKeep(), before = await tool('meminfo');
    await tool('killAll');
    const u = await tool('userApps'), v = await tool('vpnApps'), apps = u.ok ? Tools.parseUserApps(u.text) : [];
    const vpn = v.ok && Array.isArray(v.apps) ? v.apps : null;
    let quiet = false;                                  // a stop got no answer: the TV went quiet, so stop asking and say so
    for (const p of vpn ? Tools.closable(apps, keep, vpn.concat(self())) : []) {
      if ((await tool('stopApp', p)).error === NO_ANSWER) { quiet = true; break; }
    }
    const after = await tool('meminfo');
    mem.info = after;
    if (u.ok) mem.apps = apps;
    if (vpn) mem.vpn = vpn;
    mem.result = quiet ? NO_ANSWER : !vpn ? why(v) : before.ok && after.ok ? `Freed ${Math.max(0, Math.round((after.avail - before.avail) / 1e6))} MB`
      : why(before.ok ? after : before);
    mem.busy = false;
    draw();
  }

  async function stopOne(pkg) {
    mem.busy = true;
    draw();
    await tool('stopApp', pkg);
    mem.info = await tool('meminfo');
    mem.busy = false;
    draw();
  }

  /** trimCaches (every app) or clearCache (one app), then the sizes again: free space fresh from Android, the app list less
   *  what was cleared (diskstats' app sizes are only counted once a day, see Tools.lessCleared). */
  async function clean(name, pkg) {
    tidy.busy = true;
    tidy.result = null;
    draw();
    const r = await tool(name, pkg), trim = name === 'trimCaches';
    if (r.ok && (trim || /Success/.test(r.text))) tidy.cleared.push(trim ? '*' : pkg);   // pm clear prints Success, or why not
    tidy.result = !r.ok ? why(r) : trim ? `Free space: ${size(r.before)} → ${size(r.after)}` : null;
    tidy.disk = await tool('diskstats');
    tidy.busy = false;
    draw();
  }

  /** health.json is read by Java, checked here, and only the good checks go back to run. */
  function runHealth() {
    if (health.running) return;
    const cfg = Tools.healthConfig(TV.healthText());
    health = { running: true, rows: [], file: cfg.error, checks: cfg.checks, error: null };
    // HEALTH_GAP counts from the last row (onHealthRow restarts it), not from the start: a slow check is not a quiet TV
    expect('healthDone', () => TV.health(JSON.stringify(cfg.checks)), HEALTH_GAP)
      .then(r => { health.running = false; health.error = r.ok === false ? why(r) : null; draw(); });
    draw();
  }

  function runNetwork() {
    if (net.running) return;
    const hosts = Tools.healthConfig(TV.healthText()).checks.map(c => new URL(c.url !== undefined ? c.url : c.base).hostname);
    net = { running: true, answer: null };
    expect('network', () => TV.network(JSON.stringify(hosts.filter((h, i) => hosts.indexOf(h) === i))), 120000)   // Java: ~100 s at worst
      .then(a => { net = { running: false, answer: a }; draw(); });
    draw();
  }

  window.ToolsUI = {
    /** kit (from app.js): el, button, ask, device(), draw(nodes, key). */
    init(k) { kit = k; },

    /** The Tools tab opened. */
    show() {
      if (view === 'home') readExpiry();
      draw();
    },

    /** Back: Never close → Free up memory, a tool → the tiles. False on the tiles (app.js goes to Apps). */
    back() {
      if (view === 'home') return false;
      if (view === 'keep') { view = 'memory'; draw('keep'); } else open('home', 'tile:' + view);
      return true;
    },

    onResult(name, r) { waiting.answer(name, r); },

    /** A row of the running check. alive() is false while Java is still sending a timed-out run's rows: they are dropped. */
    onHealthRow(row) {
      if (!waiting.alive('healthDone') || !health.running || !row) return;
      health.rows.push(row);
      draw();
    },
  };
})();
