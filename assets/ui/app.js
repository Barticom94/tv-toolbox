// The screens. store.js decides what each row shows; this file draws it, moves the focus and talks to Java (window.TV).
// Strict CSP: no inline style or handlers, and catalogue text only ever goes in through textContent.
(function () {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const FAILED = 'Install failed', CANCELLED = 'Cancelled', MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // The word at a row's end is amber when there is something to do, quiet when there isn't.
  const TODO = ['Update', 'Try again'], DONE = ['Open', 'Installed', 'Turned off', 'Not for this TV'];

  let device = {}, answer = null, list = null, toolsOn = false, tab = 'apps', focused = null, shown = false, closeDialog = null;
  let parked = null;                                // the open tab, held there because its page had nothing to focus yet
  let swap = null;                                  // {id, resumed}: a Swap waiting for the uninstall screen to close
  const queue = new Store.Queue(), progress = {}, notes = {}, keyFor = {};
  let parts = {};                                   // id → the row's live parts, repainted on progress without a redraw

  // "Keep it" is remembered per app id. Storage can be missing or full: then it lasts until the app closes.
  let keptIds = [];
  try { const v = JSON.parse(localStorage.getItem('keep')); if (Array.isArray(v)) keptIds = v; } catch (e) { /* none saved */ }
  function keep(id) {
    if (!keptIds.includes(id)) keptIds.push(id);
    try { localStorage.setItem('keep', JSON.stringify(keptIds)); } catch (e) { /* kept for this run only */ }
  }

  function readDevice() {
    try { device = JSON.parse(TV.device()) || {}; } catch (e) { device = {}; }
  }

  const when = ms => {
    const d = new Date(ms), p = n => String(n).padStart(2, '0');
    return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // ---- installs: one at a time through the queue; TV.install is only ever called while the queue is idle ----

  function entryOf(id) {
    const c = list && list.cards.find(x => x.id === id);
    if (c) return c.entry;
    return list && list.selfUpdate && list.selfUpdate.id === id ? list.selfUpdate : null;
  }

  function install(ids) {
    const busy = queue.busy;
    ids.forEach(id => { delete notes[id]; queue.add(id); });
    if (busy) TV.nudge(); else pump();             // busy: a confirm screen left with Home comes back
    render();
  }

  function pump() {
    for (let id; (id = queue.next()) !== null;) {
      const e = entryOf(id), abi = e && Store.pickFile(e, device);
      if (abi) { progress[id] = 0; TV.install(id, abi); return; }
      queue.done(id);                               // gone from the catalogue since it was queued
      notes[id] = FAILED;
    }
  }

  /** What a row's end says right now: an install in progress or its outcome, else the store's look. pct: the bar, null for none. */
  function statusOf(id, look) {
    if (queue.running === id) return progress[id] >= 100 ? { text: 'Installing', pct: 100 } : { text: (progress[id] || 0) + '%', pct: progress[id] || 0 };
    if (queue.waiting.includes(id)) return { text: 'Waiting', pct: 0 };
    const m = notes[id];
    if (m === CANCELLED) return { text: look.text, detail: CANCELLED };
    if (m != null) return { text: 'Try again', detail: m === FAILED ? FAILED : m };   // Android's message verbatim
    return look;
  }

  /** A yes/no question; focus starts on No and goes back where it was. Back closes it without either. */
  function ask(text, yes, fn, no, noFn) {
    const back = focused && [focused.dataset.key, focused.dataset.card];
    const close = () => { $('dialog').hidden = true; closeDialog = null; restore(back && back[0], back && back[1]); };
    $('dialog-text').textContent = text;
    $('dialog-yes').textContent = yes;
    $('dialog-no').textContent = no || 'Cancel';
    $('dialog-yes').onclick = () => { close(); fn(); };
    $('dialog-no').onclick = () => { close(); if (noFn) noFn(); };
    closeDialog = close;
    $('dialog').hidden = false;
    focus($('dialog-no'));
  }

  function act(c, what) {
    if (what === 'install') install([c.id]);
    else if (what === 'open') TV.open(c.entry.package);
    else if (what === 'swap') ask(`${c.entry.name} came from another store. Swap it for this one? Its settings and sign-ins go.`, 'Swap', () => {
      swap = { id: c.id, resumed: false };
      TV.uninstall(c.entry.package);
    }, 'Keep it', () => { keep(c.id); render(); });
  }

  // ---- drawing ----

  function button(text, key, card, fn) {
    const b = el('button', 'pill f', text);
    b.dataset.key = key;
    if (card) b.dataset.card = card;
    b.onclick = e => { e.stopPropagation(); fn(); };   // a button inside a row must not run the row's own action too
    return b;
  }

  function iconEl(e) {
    const tile = el('div', 'icon tile', (Array.from(String(e.name || '?').trim())[0] || '?').toUpperCase());
    if (typeof e.icon !== 'string' || !e.icon) return tile;
    const img = el('img', 'icon');
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(tile));
    img.src = e.icon;
    return img;
  }

  /** One line per app: icon, name, blurb, and the word for what OK does. `extra` buttons sit after it, reached with Right. */
  function appRow(id, entry, blurb, look, onOk, extra) {
    const r = el('div', 'row app f'), end = el('div', 'end'), word = el('p', 'act'), sub = el('p', 'detail'), track = el('span', 'track'), fill = el('span', 'fill');
    r.dataset.key = r.dataset.card = id;
    r.onclick = onOk;
    end.append(word, sub);
    track.append(fill);
    r.append(iconEl(entry), el('p', 'name', entry.name), el('p', 'blurb', blurb || ''), end, ...extra, track);
    parts[id] = { r, word, sub, fill, look };
    paint(id);
    return r;
  }

  function paint(id) {
    const p = parts[id];
    if (!p) return;
    const s = statusOf(id, p.look);
    p.word.textContent = s.text;
    p.sub.textContent = s.detail || '';
    p.sub.hidden = !s.detail;
    p.r.classList.toggle('todo', TODO.includes(s.text));
    p.r.classList.toggle('done', DONE.includes(s.text));
    p.r.classList.toggle('busy', s.pct != null);
    if (s.pct != null) p.fill.style.transform = `scaleX(${s.pct / 100})`;   // CSSOM, which the CSP allows
  }

  function cardRow(c) {
    const kept = c.state === 'foreign' && keptIds.includes(c.id);
    const look = kept ? (c.installed.launch ? { act: 'open', text: 'Open' } : { act: null, text: 'Installed' }) : c;
    const extra = c.old.length ? [button('Remove old version', c.id + ':old', c.id, () => c.old.forEach(p => TV.uninstall(p)))] : [];
    return appRow(c.id, c.entry, c.entry.blurb, look, () => act(c, look.act), extra);
  }

  function setupEl() {
    const fire = !!device.fireTv, box = el('div', 'setup');
    box.append(el('h2', null, 'Allow installs first'));
    (fire ? ['Settings › My Fire TV › Developer options › Install unknown apps › TV Toolbox › On',
             'No Developer options? In My Fire TV › About, press the device name 7 times.',
             'TV Toolbox not listed? Update the Fire TV first.']
          : ['Settings › System › About: press Android TV OS build 7 times.',
             'Then press Install here, choose Settings and allow TV Toolbox.',
             'Play Protect stops it? Details › Install anyway.']).forEach(t => box.append(el('p', null, t)));
    if (fire) {
      const bar = el('div', 'bar');
      bar.append(button('Open Settings', 'settings', null, () => TV.openInstallSettings()));
      box.append(bar);
    }
    return box;
  }

  function render() {
    const root = $('apps'), had = focused && root.contains(focused) ? [focused.dataset.key, focused.dataset.card] : null;
    const first = !!list && !shown;                 // the first list in: focus starts at the top
    shown = shown || !!list;
    root.textContent = '';
    parts = {};
    if (device.canInstall === false) root.append(setupEl());
    const cards = list ? list.cards : [];
    const ups = cards.filter(c => c.state === 'update' && !c.group);   // "Only on your TV" entries update one by one
    const offline = list && list.offline && list.savedAt;
    if (offline || ups.length >= 2) {
      const bar = el('div', 'bar top');
      if (offline) bar.append(el('p', 'note', `Offline. List from ${when(list.savedAt)}.`));
      if (ups.length >= 2) bar.append(button(`Update ${ups.length} apps`,'updateAll', null, () => install(ups.map(c => c.id))));
      root.append(bar);
    }
    if (!list) root.append(el('p', 'note', 'Loading…'));
    else if (!cards.length) root.append(el('p', 'note', list.offline && !list.savedAt ? "Can't reach the store. Try again later." : 'Nothing in the store yet.'));

    const s = list && list.selfUpdate;
    if (s) root.append(appRow(s.id, s, 'New version', { act: 'install', text: 'Update', detail: device.version ? `${device.version} → ${s.versionName}` : null },
      () => install([s.id]), []));
    cards.filter(c => !c.group).forEach(c => root.append(cardRow(c)));
    const mine = cards.filter(c => c.group);
    if (mine.length) {
      root.append(el('h2', 'group', mine[0].group));
      mine.forEach(c => root.append(cardRow(c)));
    }

    if (tab !== 'apps' || !$('dialog').hidden) return;
    if (had && !first) restore(had[0], had[1]);
    else if (!focused || !document.contains(focused) || first) restore();
  }

  // ---- focus: the nearest focusable in the pressed direction, by position on screen ----

  function focusables() {
    const scope = $('dialog').hidden ? document : $('dialog');
    return Array.from(scope.querySelectorAll('.f')).filter(e => e.getClientRects().length);
  }

  function focus(e) {
    if (focused) focused.classList.remove('focus');
    document.querySelectorAll('.within').forEach(c => c.classList.remove('within'));
    focused = e || null;
    if (e !== parked) parked = null;
    if (!e) return;
    e.classList.add('focus');
    const row = e.closest('.row'), page = e.closest('.page');
    if (row && row !== e) row.classList.add('within');
    if (!page) return;
    keyFor[page.id] = [e.dataset.key, e.dataset.card];   // where each page's focus goes back to
    if (focusables().find(x => page.contains(x)) === e) page.scrollTop = 0;   // the first one: show what is above it too
    else (row || e).scrollIntoView({ block: 'nearest' });
  }

  /** Focus by key, else something on the same row, else the first thing on the page, else the open tab (parked until there is). */
  function restore(key, card) {
    const all = focusables(), pick = (key && all.find(e => e.dataset.key === key)) || (card && all.find(e => e.dataset.card === card))
      || all.find(e => !e.classList.contains('tab'));
    focus(pick || document.querySelector('.tab.on') || all[0]);
    parked = pick ? null : focused;
  }

  /** From the open tab into its page: where the focus last was there, else its first stop. False when it has none (About). */
  function enter() {
    const k = keyFor[tab] || [], inPage = focusables().filter(e => $(tab).contains(e));
    if (inPage.length) focus(inPage.find(e => e.dataset.key === k[0]) || inPage[0]);
    return inPage.length > 0;
  }

  // A row, bar or dialog moves as one box: up/down go box to box, left/right step through what is in it (the row itself first).
  const GROUP = '.row, .bar, #dialog .box';
  const boxOf = e => e.closest(GROUP) || e;

  function move(dir) {
    const all = focusables();
    if (!all.includes(focused)) { if (all.length) restore(); else scroll(dir); return; }
    const from = boxOf(focused), across = dir === 'left' || dir === 'right', onTab = focused.classList.contains('tab');
    if (onTab && dir === 'down') { if (!enter()) scroll(dir); return; }   // down from the header goes into the page, not to whatever sits below the tab
    if (across) {                                   // DOM order inside the box, so wrapped buttons stay reachable
      const mates = all.filter(e => boxOf(e) === from), i = mates.indexOf(focused) + (dir === 'right' ? 1 : -1);
      if (i >= 0 && i < mates.length) { focus(mates[i]); return; }
    }
    const a = from.getBoundingClientRect();
    let best = null, score = Infinity;
    for (const e of all) {
      const box = boxOf(e);
      if (box === from || (across && e.classList.contains('tab') !== onTab)) continue;   // left/right never cross between header and page
      const b = box.getBoundingClientRect();
      const gap = { right: b.left - a.right, left: a.left - b.right, down: b.top - a.bottom, up: a.top - b.bottom }[dir];
      if (gap < -8) continue;                       // not that way (a little slack)
      const off = across ? Math.max(0, b.top - a.bottom, a.top - b.bottom) : Math.max(0, b.left - a.right, a.left - b.right);
      const s = (off > 0 ? 1e5 : 0) + Math.max(gap, 0) + off;   // in line first, then nearest
      if (s < score || (s === score && dir === 'left')) { score = s; best = e; }   // up/down land on the row, left on its last button
    }
    if (dir === 'up' && best && best.classList.contains('tab')) best = document.querySelector('.tab.on') || best;   // up into the header: the open tab
    if (best) focus(best); else scroll(dir);
  }

  /** Nothing more that way: long text (About) scrolls instead. */
  function scroll(dir) {
    const p = $(tab);
    if (p && (dir === 'up' || dir === 'down')) p.scrollTop += (dir === 'down' ? 0.4 : -0.4) * p.clientHeight;
  }

  // ---- what Java calls ----

  const app = window.app = {
    /** Remote keys. Returns true when Back was used here; otherwise Java closes the app. */
    key(cmd) {
      if (cmd === 'back') {
        if (closeDialog) { closeDialog(); return true; }
        if (tab === 'tools' && ToolsUI.back()) return true;
        if (tab !== 'apps') {
          app.showTab('apps');
          const k = keyFor.apps || [];
          restore(k[0], k[1]);
          return true;
        }
        return false;
      }
      if (cmd === 'ok') { if (focusables().includes(focused)) focused.click(); }
      else move(cmd);
      return false;
    },

    /** Shows one page: apps, tools (toolsui.js fills #tools) or about. */
    showTab(name) {
      const page = $(name);
      if (!page || !page.classList.contains('page')) return;
      tab = name;
      document.querySelectorAll('.page').forEach(p => { p.hidden = p.id !== name; });
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
      if (name === 'about') {
        $('about-name').textContent = 'TV Toolbox ' + (device.version || '');
        $('about-tools').hidden = toolsOn || !device.healthFile;   // only a TV with health.json ever asks for ADB
        page.scrollTop = 0;
      }
      if (name === 'tools') ToolsUI.show();
      if (!focusables().includes(focused)) { const k = keyFor[name] || []; restore(k[0], k[1]); }
    },

    onResume() {
      readDevice();                                 // canInstall changes after a trip to Settings
      if (swap) swap.resumed = true;
      TV.loadCatalog();
    },

    onCatalog(a) {
      answer = a;
      list = Store.buildList(answer, device, toolsOn);
      if (swap && swap.resumed) {                   // back from the uninstall screen: install the store's copy if the other one went
        const id = swap.id, c = list.cards.find(x => x.id === id);
        swap = null;
        if (c && c.state === 'install') { install([id]); return; }
      }
      render();
    },

    onProgress(id, pct) {
      progress[id] = pct;
      paint(id);
    },

    onInstalled(id, ok, message) {
      queue.done(id);
      delete progress[id];
      if (!ok) notes[id] = message || FAILED;
      pump();
      render();
      TV.loadCatalog();                             // the row's state changed
    },

    onTools(on) {
      toolsOn = !!on;
      document.querySelectorAll('.tab').forEach(t => { if (t.dataset.tab === 'tools') t.hidden = !toolsOn; });
      if (!toolsOn && tab === 'tools') app.showTab('apps');
      if (answer) { list = Store.buildList(answer, device, toolsOn); render(); }
    },

    onResult(name, r) { ToolsUI.onResult(name, r); },
    onHealthRow(row) { ToolsUI.onHealthRow(row); },
  };

  ToolsUI.init({ el, button, ask, device: () => device,
    /** Replaces the Tools page. Focus goes to `key` (null: the first thing there), or back by key when the redraw took it away. */
    draw(nodes, key) {
      const root = $('tools'), had = focused && root.contains(focused) ? focused.dataset.key : null;
      root.textContent = '';
      root.append(...nodes);
      if (tab === 'tools' && $('dialog').hidden && (key !== undefined || !focusables().includes(focused) || (parked && focused === parked))) restore(key !== undefined ? key : had);
    } });

  // Desktop previews: the keyboard stands in for the remote. On the TV, Java takes these keys before the page sees them.
  document.addEventListener('keydown', e => {
    const cmd = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok', Escape: 'back' }[e.key];
    if (cmd) { e.preventDefault(); app.key(cmd); }
  });

  function start() {
    readDevice();
    document.querySelectorAll('.tab').forEach(t => {
      t.dataset.key = 'tab:' + t.dataset.tab;
      t.onclick = () => { app.showTab(t.dataset.tab); enter(); };   // OK on a tab opens it and steps into its list (About has none: focus stays)
    });
    render();
    TV.loadCatalog();
  }

  if (window.TV) start();
  else if (location.search.includes('fake')) {     // a desktop preview: tools/fake_tv.js stands in for Java (it isn't in the APK)
    const s = document.createElement('script');
    s.src = '../../tools/fake_tv.js';
    s.onload = start;
    document.head.appendChild(s);
  }
})();
