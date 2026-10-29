// The Tools tab: the approval switch above four tiles, and a screen for each tool. tools.js decides what the TV's answers
// mean; this file draws them and runs the steps. app.js keeps the focus and the dialog and hands them over in init().
// Strict CSP: no inline style or handlers. Shell output, package names and check names only go in through textContent.
(function () {
  const FAIL = "Couldn't read the details.", CHECKING = 'Checking…';
  const HELP = 'Without this, the TV asks "Allow USB debugging?" again after 7 days without opening TV Toolbox. '
    + 'It applies to every computer approved on this TV, your PC included.';
  const NOTE = 'Android keeps apps parked on purpose, so closed apps take longer to open next time.';
  const TILES = [['health', 'Nuvio health check'], ['memory', 'Free up memory'], ['network', 'Network check'], ['tidy', 'Restart and tidy']];
  // Health rows land as each check finishes; they are shown in this order so they don't jump about between runs.
  const KIND = { 'nuvio-app': 0, service: 1, yours: 2 };
  const BUILT_IN = ['Nuvio app', 'Nuvio sign-in', 'Nuvio sync', 'TorBox', 'TorBox (independent monitor)', 'Cinemeta (independent monitor)'];
  const DNS = { ok: 'OK', blocked: 'Pi-hole (or your ISP) is blocking it', failed: "can't be found" };
  const PKG = /^[A-Za-z0-9_.]+$/;

  let kit, view = 'home', expiry = null, expiryBusy = false;   // expiry: true once the approval never expires
  const mem = { info: null, apps: null, keep: [], busy: false, result: null };
  const tidy = { disk: null, busy: false, result: null };
  let health = { running: false, rows: [], file: null, checks: [] };
  let net = { running: false, answer: null };
  const waiting = {};

  // ---- talking to Java ----

  /** The next answer to `name`. Java runs tools one at a time, so each name's answers come back in the order asked. */
  function expect(name, send) {
    return new Promise(res => { (waiting[name] = waiting[name] || []).push(res); send(); });
  }
  const tool = (name, arg) => expect(name, () => TV.tool(name, arg == null ? null : arg));
  const list = s => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : null; } catch (e) { return null; } };
  const self = () => kit.device().self || 'local.adam.tvtoolbox';
  const size = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB';

  // ---- drawing ----

  const el = (tag, cls, text) => kit.el(tag, cls, text);

  function draw(key) {
    kit.draw({ home, memory, keep: keepScreen, tidy: tidyScreen, health: healthScreen, network: networkScreen }[view](), key);
  }

  function heading(title, again, running) {
    const h = el('div', 'head');
    h.append(el('h2', null, title));
    if (again) { again.disabled = running; h.append(again); }
    if (running) h.append(el('p', 'note', CHECKING));
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

  function toggle(key, on, parts, fn) {
    const b = el('button', 'card switch' + (on ? ' on' : '')), text = el('div', 'text');
    b.dataset.key = key;
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', String(on));
    text.append(...parts);
    b.append(text, el('span', 'knob'));
    b.onclick = fn;
    return b;
  }

  /** A one-line list row: the name (cut short with … when long), a quieter note, the amount; buttons go after it. */
  function row(name, amount, sub) {
    const r = el('div', 'card row');
    r.append(el('p', 'name', name));
    if (sub) r.append(el('p', 'sub', sub));
    r.append(el('p', 'size', amount));
    return r;
  }

  /** A box with a state mark. The mark's shape differs as well as its colour, so colour is never the only sign. */
  function mark(state, text) {
    const box = el('div', 'card check ' + state), line = el('div', 'line');
    line.append(el('span', 'mark'), el('h3', 'name', text));
    box.append(line);
    return box;
  }

  function home() {
    const parts = [el('h3', 'name', 'Stop the debugging approval expiring'), el('p', 'blurb', HELP)];
    if (expiry) parts.push(el('p', 'state', 'Approval never expires'));
    const sw = toggle('expiry', !!expiry, parts, stopExpiry);
    sw.classList.add('expiry');
    if (!expiry) sw.classList.add('f');              // nothing can turn expiry back on, so once set it is a line, not a stop
    const grid = el('div', 'grid tiles');
    TILES.forEach(t => {
      const b = el('button', 'card f');
      b.dataset.key = 'tile:' + t[0];
      b.append(el('h3', 'name', t[1]));
      b.onclick = () => open(t[0]);
      grid.append(b);
    });
    return [sw, grid];
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
      if (!top.length) right.append(el('p', 'note', FAIL));
      top.forEach(p => {
        const pkg = p.name.split(':')[0], r = row(p.name, size(p.kb * 1024));
        if (mem.apps && mem.apps.includes(pkg) && pkg !== self()) r.append(busyButton('Stop', 'stop:' + p.name, () => stopOne(pkg), mem.busy));
        right.append(r);
      });
    }
    return [heading('Free up memory'), columns(left, right)];
  }

  function keepScreen() {
    const out = [heading('Never close')];
    if (!mem.info) return out;
    if (!mem.apps) return out.concat(el('p', 'note', FAIL));
    const grid = el('div', 'grid two');
    mem.apps.filter(p => p !== self()).sort().forEach(p => {
      const t = toggle('keep:' + p, mem.keep.includes(p), [el('p', 'name', p)], () => setKeep(p));
      t.classList.add('f');
      grid.append(t);
    });
    return out.concat(grid);
  }

  /** One column: package names need the width more than the two buttons need a column of their own. */
  function tidyScreen() {
    const d = tidy.disk, out = [heading('Restart and tidy')], top = el('div', 'actions'), bar = el('div', 'bar');
    bar.append(kit.button('Restart TV', 'restart', null, () => kit.ask('Restart the TV now?', 'Restart', () => tool('reboot'))),
               busyButton('Clear all app caches', 'trim', () => clean('trimCaches'), tidy.busy));
    top.append(bar);
    if (tidy.result) top.append(el('p', 'big', tidy.result));
    out.push(top);
    if (!d) return out;
    if (d.ok) out.push(el('p', 'big', `Free space: ${size(d.free)}`));
    out.push(el('h3', 'title', 'Biggest apps'));
    const apps = d.ok ? Tools.appSizes(d.text).slice(0, 6) : [], each = kit.device().sdk >= 34;
    if (!apps.length) out.push(el('p', 'note', FAIL));
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
    return [heading('Nuvio health check', kit.button('Check again', 'again', null, runHealth), health.running), grid];
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
    const out = [heading('Network check', kit.button('Check again', 'again', null, runNetwork), net.running)], n = net.answer;
    if (net.running) return out.concat(el('p', 'big', 'This can take up to a minute.'));   // nothing lands until it all has
    if (!n) return out;
    if (typeof n !== 'object' || n.ok === false) return out.concat(el('p', 'note', FAIL));
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
      'Connection: ' + (n.type === 'ethernet' ? 'Wired' : n.type === 'wifi' ? wifi : 'Other'),
      'Router ping: ' + ping(p.gateway),
      'Internet ping: ' + ping(p.internet),
      'Download speed: ' + (typeof n.speedMbps === 'number' ? Math.round(n.speedMbps) + ' Mb/s' : 'no answer'),
      'DNS servers: ' + (Array.isArray(n.dns) && n.dns.length ? n.dns.join(', ') : 'none found'),
      'Private DNS: ' + (dns.active ? 'on' + (dns.name ? ', ' + dns.name : '') : 'off'),
    ];
  }

  // ---- what each screen does ----

  function open(id, key) {
    view = id;
    if (id === 'home') readExpiry();
    else if (id === 'memory') { mem.result = null; loadKeep(); readMemory(); }
    else if (id === 'tidy') { tidy.result = null; tool('diskstats').then(d => { tidy.disk = d; draw(); }); }
    else if (id === 'health') runHealth();
    else if (id === 'network') runNetwork();
    draw(key || null);                               // null: the first thing on the new screen
  }

  async function readExpiry() {
    const r = await tool('expiryGet');
    expiry = !!r.ok && r.text === '0';
    draw();
  }

  async function stopExpiry() {
    if (expiryBusy) return;
    expiryBusy = true;
    await tool('expiryOff');
    await readExpiry();
    expiryBusy = false;
  }

  async function readMemory() {
    const a = await Promise.all([tool('meminfo'), tool('userApps')]);
    mem.info = a[0];
    mem.apps = a[1].ok ? Tools.parseUserApps(a[1].text) : null;
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

  /** kill-all for the cached apps, then stop every user app not on the list, one after another. */
  async function closeApps() {
    mem.busy = true;
    mem.result = null;
    draw();
    const keep = await loadKeep(), before = await tool('meminfo');
    await tool('killAll');
    const u = await tool('userApps'), apps = u.ok ? Tools.parseUserApps(u.text) : [];
    for (const p of Tools.closable(apps, keep)) if (p !== self()) await tool('stopApp', p);   // never this app, whatever the list says
    const after = await tool('meminfo');
    mem.info = after;
    if (u.ok) mem.apps = apps;
    mem.result = before.ok && after.ok ? `Freed ${Math.max(0, Math.round((after.avail - before.avail) / 1e6))} MB` : FAIL;
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

  /** trimCaches (every app) or clearCache (one app), then the sizes again. */
  async function clean(name, pkg) {
    tidy.busy = true;
    tidy.result = null;
    draw();
    const r = await tool(name, pkg);
    tidy.result = !r.ok ? FAIL : name === 'trimCaches' ? `Free space: ${size(r.before)} → ${size(r.after)}` : null;
    tidy.disk = await tool('diskstats');
    tidy.busy = false;
    draw();
  }

  /** health.json is read by Java, checked here, and only the good checks go back to run. */
  function runHealth() {
    if (health.running) return;
    const cfg = Tools.healthConfig(TV.healthText());
    health = { running: true, rows: [], file: cfg.error, checks: cfg.checks };
    expect('healthDone', () => TV.health(JSON.stringify(cfg.checks))).then(() => { health.running = false; draw(); });
    draw();
  }

  function runNetwork() {
    if (net.running) return;
    const hosts = Tools.healthConfig(TV.healthText()).checks.map(c => new URL(c.url !== undefined ? c.url : c.base).hostname);
    net = { running: true, answer: null };
    expect('network', () => TV.network(JSON.stringify(hosts.filter((h, i) => hosts.indexOf(h) === i))))
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

    onResult(name, r) {
      const q = waiting[name];
      if (q && q.length) q.shift()(r || {});
    },

    onHealthRow(row) {
      if (!health.running || !row) return;
      health.rows.push(row);
      draw();
    },
  };
})();
