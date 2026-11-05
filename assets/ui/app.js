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
  const TODO = ['Update', 'Try again', 'Start', 'Open settings', 'Reinstall'], DONE = ['Open', 'Installed', 'Turned off', 'Not for this TV', 'Done'];

  let device = {}, answer = null, list = null, toolsOn = false, tab = 'apps', focused = null, shown = false, closeDialog = null;
  let parked = null;                                // the open tab, held there because its page had nothing to focus yet
  let swap = null;                                  // {id, resumed}: a Swap waiting for the uninstall screen to close
  let pendingSetup = [];                            // Start's other apps, queued once installs are allowed (one "not allowed" dialog, not four)
  let homeNote = null;                              // "Can't open Projectivy", until the next resume
  let lastStates = {}, setupOpened = false;         // the setup page's focus rule: step states at the last draw, and "just opened"
  const queue = new Store.Queue(), progress = {}, notes = {}, keyFor = {};
  let parts = {};                                   // id → the live parts of every row drawn for it, repainted on progress without a redraw

  // "Keep it" is remembered per app id. Storage can be missing or full: then it lasts until the app closes.
  let keptIds = [];
  try { const v = JSON.parse(localStorage.getItem('keep')); if (Array.isArray(v)) keptIds = v; } catch (e) { /* none saved */ }
  function keep(id) {
    if (!keptIds.includes(id)) keptIds.push(id);
    try { localStorage.setItem('keep', JSON.stringify(keptIds)); } catch (e) { /* kept for this run only */ }
  }
  // Once every setup step is done the Apps row stops appearing, so a relative who later removes an app isn't nagged.
  let setupDone = false;
  try { setupDone = localStorage.getItem('setupDone') === '1'; } catch (e) { /* not saved */ }

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
    for (let id; (id = queue.next('toolbox')) !== null;) {   // the toolbox updates itself last, so it never cuts other installs short
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

  /** One line per app: icon, name, blurb, and the word for what OK does. `key` names the row (focus, the room), `id` is the
   *  queue id whose installs it shows. `extra` buttons sit after it, reached with Right. */
  function appRow(key, id, entry, blurb, look, onOk, extra = []) {
    const r = el('div', 'row app f'), end = el('div', 'end'), word = el('p', 'act'), sub = el('p', 'detail'), track = el('span', 'track'), fill = el('span', 'fill');
    r.dataset.key = r.dataset.card = key;
    r.onclick = onOk;
    end.append(word, sub);
    track.append(fill);
    r.append(iconEl(entry), el('p', 'name', entry.name), el('p', 'blurb', blurb || ''), end, ...extra, track);
    (parts[id] = parts[id] || []).push({ r, word, sub, fill, look });
    paint(id);
    return r;
  }

  function paint(id) {
    (parts[id] || []).forEach(p => {
      const s = statusOf(id, p.look);
      p.word.textContent = s.text;
      p.sub.textContent = s.detail || '';
      p.sub.hidden = !s.detail;
      p.r.classList.toggle('todo', TODO.includes(s.text));
      p.r.classList.toggle('done', DONE.includes(s.text));
      p.r.classList.toggle('busy', s.pct != null);
      if (s.pct != null) p.fill.style.transform = `scaleX(${s.pct / 100})`;   // CSSOM, which the CSP allows
    });
  }

  function cardRow(c) {
    const kept = c.state === 'foreign' && keptIds.includes(c.id);
    const look = kept ? (c.installed.launch ? { act: 'open', text: 'Open' } : { act: null, text: 'Installed' }) : c;
    const extra = c.old.length ? [button('Remove old version', c.id + ':old', c.id, () => c.old.forEach(p => TV.uninstall(p)))] : [];
    return appRow(c.id, c.id, c.entry, c.entry.blurb, look, () => act(c, look.act), extra);
  }

  /** "Allow installs first", on Apps or on the setup page (where: 'apps' | 'setup'; Start has already pressed Install there). */
  function setupEl(where) {
    const fire = !!device.fireTv, box = el('div', 'setup');
    box.append(el('h2', null, 'Allow installs first'));
    (fire ? ['Settings › My Fire TV › Developer options › Install unknown apps › TV Toolbox › On',
             'No Developer options? In My Fire TV › About, press the device name 7 times.',
             'TV Toolbox not listed? Update the Fire TV first.']
          : ['Settings › System › About: press Android TV OS build 7 times.',
             where === 'setup' ? 'When Android asks, choose Settings and allow TV Toolbox.' : 'Then press Install here, choose Settings and allow TV Toolbox.',
             'Play Protect stops it? Details › Install anyway.']).forEach(t => box.append(el('p', null, t)));
    if (fire) {
      const bar = el('div', 'bar');
      bar.append(button('Open Settings', 'settings', null, () => TV.openInstallSettings()));
      box.append(bar);
    }
    return box;
  }

  const queued = id => queue.running === id || queue.waiting.includes(id);

  /** A row on the setup page. App steps run through the queue by app id; Home and animations are never queued. */
  function stepRow(s, pc) {
    const todo = s.state === 'todo', done = { text: s.state === 'skipped' ? 'Not for this TV' : 'Done' };
    if (s.kind === 'app') {
      const c = s.card;
      return appRow(s.key, c.id, c.entry, c.entry.blurb, todo ? { act: 'install', text: 'Install' } : { text: s.state === 'done' ? 'Installed' : 'Not for this TV' },
        todo ? () => install([c.id]) : null);
    }
    if (s.kind === 'animations') return appRow(s.key, s.key, { name: 'Faster animations', icon: 'toolbox.png' }, 'Set the three animation scales to 0.5x.',
      todo ? { text: 'Open settings', detail: s.detail } : done, todo ? () => TV.openDeveloperOptions() : null);
    const look = todo ? { text: 'Open settings', detail: homeNote }
      : s.state === 'waiting' ? { text: queued(pc.id) ? 'Waiting' : '', detail: s.detail }
      : s.state === 'reinstall' ? { text: 'Reinstall', detail: s.detail } : done;
    const ok = todo ? () => { if (!TV.openProjectivySettings()) { homeNote = "Can't open Projectivy"; render(); } }
      : s.state === 'reinstall' ? () => ask("Projectivy was installed another way, so Android won't let it be your home screen. Reinstall it from here? Its settings go.",
        'Reinstall', () => { swap = { id: pc.id, resumed: false }; TV.uninstall(Store.PROJECTIVY); })   // then onCatalog installs the store's copy
      : null;
    return appRow(s.key, s.key, { name: 'Home screen', icon: pc.entry.icon },
      'In Projectivy: Settings › General › Override current launcher, then allow it in Accessibility.', look, ok);
  }

  /** Start: open the page and queue every app still to install. Without install permission only the first goes now. */
  function startSetup(setup) {
    app.showTab('setup');
    const ids = setup.steps.filter(s => s.kind === 'app' && s.state === 'todo' && !queued(s.card.id)).map(s => s.card.id);
    pendingSetup = device.canInstall === false ? ids.slice(1) : [];
    install(device.canInstall === false ? ids.slice(0, 1) : ids);
  }

  /** Focus on the setup page after a redraw: kept by key, unless the page just opened, the focused step just finished, or
   *  focus left the page. Then: the box's Open Settings (on open), else the first step whose OK does something now (settings
   *  steps only once no install is queued or running, so focus follows the installs), else the running install, else the
   *  first step. A tab the user moved to is left alone. */
  function setupFocus(setup, had) {
    const was = lastStates, now = had && setup.steps.find(s => s.key === had[0]);
    lastStates = {};
    setup.steps.forEach(s => { lastStates[s.key] = s.state; });
    const turned = now && was[now.key] !== now.state && (now.state === 'done' || now.state === 'skipped');
    const opened = setupOpened;
    setupOpened = false;
    if (!opened && !turned && (had || (focused && focused.classList.contains('tab')))) { if (had) restore(had[0], had[1]); return; }
    const box = opened && $('setup').querySelector('.setup .f');
    if (box) { focus(box); return; }
    const live = s => s.kind === 'app' ? s.state === 'todo' && !queued(s.card.id)
      : !queue.busy && !queue.waiting.length && (s.state === 'todo' || s.state === 'reinstall');
    const t = setup.steps.find(live) || setup.steps.find(s => s.kind === 'app' && s.card.id === queue.running) || setup.steps[0];
    restore(t && t.key);
  }

  function drawSetup(setup) {
    const root = $('setup'), had = focused && root.contains(focused) ? [focused.dataset.key, focused.dataset.card] : null;
    root.textContent = '';
    const head = el('div', 'head');
    head.append(el('h2', null, 'Set up this TV'));
    root.append(head);
    if (list && list.offline && list.savedAt) root.append(el('p', 'note', `Offline. List from ${when(list.savedAt)}.`));
    if (device.canInstall === false) root.append(setupEl('setup'));
    else if (!device.fireTv && setup.left.apps) root.append(el('p', 'note', 'Play Protect stops it? Details › Install anyway.'));
    if (!setup.left.apps && !setup.left.settings) root.append(el('p', 'note', 'This TV is set up.'));
    const proj = setup.steps.find(s => s.kind === 'app' && s.card.entry.package === Store.PROJECTIVY);
    setup.steps.forEach(s => root.append(stepRow(s, proj && proj.card)));
    if ($('dialog').hidden) setupFocus(setup, had);
  }

  function render() {
    const root = $('apps'), had = focused && root.contains(focused) ? [focused.dataset.key, focused.dataset.card] : null;
    const first = !!list && !shown;                 // the first list in: focus starts at the top (on the setup row when there is one)
    shown = shown || !!list;
    root.textContent = '';
    parts = {};
    const setup = Store.setupSteps(list, device), left = setup.left.apps + setup.left.settings;
    if (setup.steps.length && !left && !setupDone) {
      setupDone = true;
      try { localStorage.setItem('setupDone', '1'); } catch (e) { /* remembered for this run only */ }
    }
    if (device.canInstall === false) root.append(setupEl('apps'));
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
    if (s) root.append(appRow(s.id, s.id, s, 'New version', { act: 'install', text: 'Update', detail: device.version ? `${device.version} → ${s.versionName}` : null },
      () => install([s.id])));
    const row = left > 0 && !setupDone;
    if (row) root.append(appRow('setup', 'setup', { name: 'Set up this TV', icon: 'toolbox.png' }, setup.blurb,
      { act: 'start', text: 'Start', detail: Store.leftText(setup.left) }, () => startSetup(setup)));
    cards.filter(c => !c.group).forEach(c => root.append(cardRow(c)));
    const mine = cards.filter(c => c.group);
    if (mine.length) {
      root.append(el('h2', 'group', mine[0].group));
      mine.forEach(c => root.append(cardRow(c)));
    }

    if (tab === 'setup') drawSetup(setup);
    else $('setup').textContent = '';               // no stale busy rows for room.js to see while it is hidden
    if (tab !== 'apps' || !$('dialog').hidden) return;
    if (had && !first) restore(had[0], had[1]);
    else if (!focused || !document.contains(focused) || first) restore(first && row ? 'setup' : null);
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

    /** Shows one page: apps, setup (no tab of its own: Apps stays lit), tools (toolsui.js fills #tools) or about. */
    showTab(name) {
      const page = $(name);
      if (!page || !page.classList.contains('page')) return;
      tab = name;
      document.querySelectorAll('.page').forEach(p => { p.hidden = p.id !== name; });
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === (name === 'setup' ? 'apps' : name)));
      if (name === 'setup') { setupOpened = true; render(); }
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
      homeNote = null;
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
      if (pendingSetup.length && device.canInstall !== false && tab === 'setup') {
        const ids = pendingSetup;
        pendingSetup = [];
        install(ids);
        return;
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
