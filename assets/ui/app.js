// The screens. store.js decides what each card shows; this file draws it, moves the focus and talks to Java (window.TV).
// Strict CSP: no inline style or handlers, and catalogue text only ever goes in through textContent.
(function () {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const FAILED = 'Install failed', MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let device = {}, answer = null, list = null, toolsOn = false, tab = 'apps', focused = null, shown = false;
  let swap = null;                                  // {id, resumed}: a Swap it waiting for the uninstall screen to close
  const queue = new Store.Queue(), progress = {}, notes = {}, keyFor = {};
  let statusEls = {};

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

  function statusText(id) {
    if (queue.running === id) return progress[id] >= 100 ? 'Installing…' : `Downloading ${progress[id] || 0}%`;
    if (queue.waiting.includes(id)) return 'Waiting to install';
    const m = notes[id];
    return m == null ? '' : m === FAILED ? FAILED : FAILED + '\n' + m;   // Android's message verbatim, under a plain line
  }

  function statusEl(id) {
    const s = el('p', 'status', statusText(id));
    s.hidden = !s.textContent;
    statusEls[id] = s;
    return s;
  }

  /** A yes/cancel question; focus starts on Cancel and goes back where it was. */
  function ask(text, yes, fn) {
    const back = focused && [focused.dataset.key, focused.dataset.card];
    const close = () => { $('dialog').hidden = true; restore(back && back[0], back && back[1]); };
    $('dialog-text').textContent = text;
    $('dialog-yes').textContent = yes;
    $('dialog-yes').onclick = () => { close(); fn(); };
    $('dialog-no').onclick = close;
    $('dialog').hidden = false;
    focus($('dialog-no'));
  }

  function act(c, what) {
    if (what === 'install') install([c.id]);
    else if (what === 'open') TV.open(c.entry.package);
    else if (what === 'keep') { keep(c.id); render(); }
    else if (what === 'swap') ask("Swapping deletes this app's settings and sign-ins. Swap it?", 'Swap', () => {
      swap = { id: c.id, resumed: false };
      TV.uninstall(c.entry.package);
    });
  }

  // ---- drawing ----

  function button(text, key, card, fn) {
    const b = el('button', 'btn f', text);
    b.dataset.key = key;
    if (card) b.dataset.card = card;
    b.onclick = fn;
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

  function cardEl(id, entry, badge, buttons) {
    const node = el('div', 'card'), top = el('div', 'top'), text = el('div');
    node.dataset.card = id;
    text.append(el('h3', 'name', entry.name));
    if (entry.blurb) text.append(el('p', 'blurb', entry.blurb));
    top.append(iconEl(entry), text);
    node.append(top);
    if (badge) node.append(el('p', 'badge', badge));
    node.append(statusEl(id));
    if (buttons.length) {
      const row = el('div', 'buttons');
      row.append(...buttons);
      node.append(row);
    } else {                                        // nothing to press: the card itself takes the focus
      node.classList.add('f');
      node.dataset.key = id;
    }
    return node;
  }

  function appCard(c) {
    const kept = c.state === 'foreign' && keptIds.includes(c.id);
    const buttons = (kept ? [] : c.buttons).map(b => button(b.text, c.id + ':' + b.act, c.id, () => act(c, b.act)));
    if (c.old.length) buttons.push(button('Remove old version', c.id + ':old', c.id, () => c.old.forEach(p => TV.uninstall(p))));
    return cardEl(c.id, c.entry, c.badge, buttons);
  }

  function setupEl() {
    const fire = !!device.fireTv, box = el('div', 'banner setup');
    box.append(el('p', 'lead', 'Before the first install, allow TV Toolbox to install apps:'));
    (fire ? ['Settings › My Fire TV › Developer Options › Install unknown apps › TV Toolbox › On',
             'No Developer Options? Go to My Fire TV › About and press the device name 7 times.',
             'TV Toolbox not in the list? Check for a Fire TV update first.']
          : ['Settings › System › About › press "Android TV OS build" until it says you\'re a developer.',
             'Then press Install on any app, choose Settings on the pop-up and set TV Toolbox to Allowed.',
             'If Play Protect stops an install, choose Details › Install anyway.']).forEach(t => box.append(el('p', null, t)));
    if (fire) box.append(button('Open Settings', 'settings', null, () => TV.openInstallSettings()));
    return box;
  }

  function render() {
    const root = $('apps'), had = focused && root.contains(focused) ? [focused.dataset.key, focused.dataset.card] : null;
    const first = !!list && !shown;                 // the first list in: focus starts at the top, not on About
    shown = shown || !!list;
    root.textContent = '';
    statusEls = {};
    if (device.canInstall === false) root.append(setupEl());
    const cards = list ? list.cards : [];
    if (list && list.selfUpdate) {
      const b = el('div', 'banner'), t = el('div', 'text');
      t.append(el('p', null, 'A new TV Toolbox is ready.'), statusEl(list.selfUpdate.id));
      b.append(t, button('Install', 'self', null, () => install([list.selfUpdate.id])));
      root.append(b);
    }
    if (list && list.offline && list.savedAt) root.append(el('div', 'banner', `Couldn't reach the store, showing the list from ${when(list.savedAt)}`));
    const ups = cards.filter(c => c.state === 'update' && !c.group);   // "Only on your TV" entries update one by one
    if (ups.length >= 2) {
      const bar = el('div', 'bar');
      bar.append(button(`Update all (${ups.length})`, 'updateAll', null, () => install(ups.map(c => c.id))));
      root.append(bar);
    }
    if (!list) root.append(el('p', 'note', 'Loading the store…'));
    else if (!cards.length) root.append(el('p', 'note', list.offline && !list.savedAt
      ? "Couldn't reach the store. Try again later." : 'The store is empty right now. Try again later.'));

    const grid = el('div', 'grid');
    cards.filter(c => !c.group).forEach(c => grid.append(appCard(c)));
    grid.append(cardEl('about', { name: 'TV Toolbox ' + (device.version || '') }, null,
      [button('About', 'about', 'about', () => app.showTab('about'))]));
    root.append(grid);
    const mine = cards.filter(c => c.group);
    if (mine.length) {
      const g = el('div', 'grid');
      mine.forEach(c => g.append(appCard(c)));
      root.append(el('h2', 'group', mine[0].group), g);
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
    if (!e) return;
    e.classList.add('focus');
    const card = e.closest('.card'), page = e.closest('.page');
    if (card && card !== e) card.classList.add('within');
    if (!page) return;
    if (focusables().find(x => page.contains(x)) === e) page.scrollTop = 0;   // the first one: show the banners above it too
    else (card || e).scrollIntoView({ block: 'nearest' });
  }

  /** Focus by key, else something on the same card, else the first thing on the page. */
  function restore(key, card) {
    const all = focusables();
    focus((key && all.find(e => e.dataset.key === key)) || (card && all.find(e => e.dataset.card === card))
      || all.find(e => !e.classList.contains('tab')) || all[0]);
  }

  // A card, banner, bar or dialog moves as one box: up/down go card to card, left/right step through its buttons first.
  const GROUP = '.card, .banner, .bar, #dialog .box';
  const boxOf = e => e.closest(GROUP) || e;

  function move(dir) {
    const all = focusables();
    if (!all.includes(focused)) { if (all.length) restore(); else scroll(dir); return; }
    const from = boxOf(focused), across = dir === 'left' || dir === 'right';
    if (across) {                                   // DOM order inside the box, so wrapped buttons stay reachable
      const mates = all.filter(e => boxOf(e) === from && e !== from), i = mates.indexOf(focused) + (dir === 'right' ? 1 : -1);
      if (i >= 0 && i < mates.length) { focus(mates[i]); return; }
    }
    const a = from.getBoundingClientRect();
    let best = null, score = Infinity;
    for (const e of all) {
      const box = boxOf(e);
      if (box === from) continue;
      const b = box.getBoundingClientRect();
      const gap = { right: b.left - a.right, left: a.left - b.right, down: b.top - a.bottom, up: a.top - b.bottom }[dir];
      if (gap < -8) continue;                       // not that way (a little slack for the focus lift)
      const off = across ? Math.max(0, b.top - a.bottom, a.top - b.bottom) : Math.max(0, b.left - a.right, a.left - b.right);
      const s = (off > 0 ? 1e5 : 0) + Math.max(gap, 0) + off;   // in line first, then nearest
      if (s < score || (s === score && dir === 'left')) { score = s; best = e; }   // left lands on a card's last button
    }
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
        if (!$('dialog').hidden) { $('dialog-no').click(); return true; }
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
      if (focused && $(tab).contains(focused)) keyFor[tab] = [focused.dataset.key, focused.dataset.card];
      tab = name;
      document.querySelectorAll('.page').forEach(p => { p.hidden = p.id !== name; });
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === (name === 'about' ? 'apps' : name)));
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
      const s = statusEls[id];
      if (s) { s.textContent = statusText(id); s.hidden = false; }
    },

    onInstalled(id, ok, message) {
      queue.done(id);
      delete progress[id];
      if (!ok) notes[id] = message || FAILED;
      pump();
      render();
      TV.loadCatalog();                             // the card's state changed
    },

    onTools(on) {
      toolsOn = !!on;
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('f', toolsOn);          // a lone Apps tab is a label, not a stop
        if (t.dataset.tab === 'tools') t.hidden = !toolsOn;
      });
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
      if (tab === 'tools' && $('dialog').hidden && (key !== undefined || !focusables().includes(focused))) restore(key !== undefined ? key : had);
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
      t.onclick = () => app.showTab(t.dataset.tab);
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
