// Pure store decisions: what each app card shows. Java supplies the data, this file decides.
// No DOM, no fetch, no dynamic code (the page runs under a strict CSP). Plain ES2017 so an older TV WebView runs it.
// Loads both ways: module.exports under node (tools/check_store.mjs), window.Store in the page.
(function () {
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isNum = n => typeof n === 'number' && isFinite(n);

  /** The catalogue file this TV gets: armeabi-v7a when the TV runs it and the entry has it, else universal. */
  function fileFor(entry, device) {
    const files = Array.isArray(entry.files) ? entry.files : [];
    const by = abi => files.find(f => f && f.abi === abi);
    return (device.abis || []).includes('armeabi-v7a') && by('armeabi-v7a') || by('universal') || null;
  }

  const pickFile = (entry, device) => { const f = fileFor(entry, device); return f ? f.abi : null; };

  // Each file carries its own version (ABI splits can be numbered differently); the entry's is the fallback.
  const fileCode = (entry, file) => isNum(file.versionCode) ? file.versionCode : entry.versionCode;
  const fileName = (entry, file) => file.versionName || entry.versionName;

  /** Spec 5.3, in order: unsupported, install, off, foreign, update, open, newer. */
  function cardState(entry, installed, device) {
    const file = fileFor(entry, device);
    if (!file || entry.minSdk > device.sdk) return 'unsupported';
    if (!installed) return 'install';
    if (installed.enabled === false) return 'off';
    if (String(installed.signer).toLowerCase() !== String(entry.signer).toLowerCase()) return 'foreign';
    const want = fileCode(entry, file);
    return installed.code < want ? 'update' : installed.code === want ? 'open' : 'newer';
  }

  /** What a row says and does: OK runs `act` (null: nothing to do), `text` is the word at its end, `detail` the small line under it. */
  function label(entry, state, installed, device) {
    const row = (act, text, detail) => ({ act, text, detail: detail || null });
    switch (state) {
      case 'install': return row('install', 'Install');
      case 'update': return row('install', 'Update', `${installed.name} → ${fileName(entry, fileFor(entry, device) || {})}`);
      case 'open': case 'newer': return installed.launch ? row('open', 'Open') : row(null, 'Installed');   // no launcher activity: nothing to open
      case 'foreign': return row('swap', 'Swap', 'From another store');
      case 'off': return row(null, 'Turned off', device.fireTv ? 'Amazon may have blocked it' : null);
      default: return row(null, 'Not for this TV');
    }
  }

  /** The packages this entry replaces that are installed right now. */
  const oldFound = (entry, answer) => {
    const have = (answer && answer.installed) || {};
    return (Array.isArray(entry.replaces) ? entry.replaces : []).filter(p => has(have, p));
  };

  const valid = e => !!e && typeof e === 'object' && !!e.id && !!e.name && !!e.package && isNum(e.versionCode) && !!e.signer
    && Array.isArray(e.files) && e.files.length > 0;

  const MINE = 'Only on your TV';

  /** One card per valid entry, in catalogue order; a bad entry is dropped and the rest still show.
   *  With Tools on, hidden entries (except the toolbox itself) follow in a last group. */
  function buildList(answer, device, toolsOn) {
    answer = answer || {};
    const installed = answer.installed || {};
    const apps = ((answer.catalog && answer.catalog.apps) || []).filter(valid);
    const card = (entry, group) => {
      const inst = has(installed, entry.package) ? installed[entry.package] : undefined;
      const state = cardState(entry, inst, device);
      return { id: entry.id, entry, state, installed: inst, group: group || null, old: oldFound(entry, answer), ...label(entry, state, inst, device) };
    };
    const cards = apps.filter(e => !e.hidden).map(e => card(e));
    if (toolsOn) apps.filter(e => e.hidden && e.id !== 'toolbox').forEach(e => cards.push(card(e, MINE)));

    const tb = apps.find(e => e.id === 'toolbox'), me = has(installed, device.self) ? installed[device.self] : null, file = tb && fileFor(tb, device);
    const selfUpdate = file && me && me.code < fileCode(tb, file) ? tb : null;
    return { cards, selfUpdate, offline: answer.offline === true, savedAt: answer.savedAt || null };
  }

  const PROJECTIVY = 'com.spocky.projengmenu';
  const ABOUT = 'Settings › System › About: press Android TV OS build 7 times.';
  const SLOW = 0.5;   // an animation scale at or below this counts as sped up

  /** Spec 2: the steps of "Set up this TV" (one per flagged app, then Home and Animations on Google TV), what is left, and a one-line blurb. */
  function setupSteps(list, device) {
    const cards = ((list && list.cards) || []).filter(c => !c.group && c.entry.setup === true);
    if (!cards.length) return { steps: [], left: { apps: 0, settings: 0 }, blurb: '' };
    const isProj = c => c.entry.package === PROJECTIVY;
    const step = (key, kind, card, state, detail) => ({ key, kind, card, state, detail: detail || null });
    const apps = cards.filter(c => !isProj(c)).concat(cards.filter(isProj))
      .map(c => step('setup:' + c.id, 'app', c, c.state === 'install' ? 'todo' : c.state === 'unsupported' ? 'skipped' : 'done'));
    const steps = apps.slice();
    const pc = cards.find(isProj);
    if (!device.fireTv && pc) {
      const blocked = (device.a11yApps || []).includes(PROJECTIVY) ? null : device.homeBlocked;
      steps.push(pc.state === 'unsupported' || pc.state === 'off' ? step('setup:home', 'home', null, 'skipped')
        : pc.state === 'install' ? step('setup:home', 'home', null, 'waiting', 'Install Projectivy first')
        : blocked === null ? step('setup:home', 'home', null, 'done')
        : blocked ? step('setup:home', 'home', null, 'reinstall', 'Android blocks this copy')
        : step('setup:home', 'home', null, 'todo'));
    }
    const a = device.animations;
    if (!device.fireTv && Array.isArray(a) && a.length === 3) {
      const slow = a.filter(n => n > SLOW).length;
      steps.push(step('setup:animations', 'animations', null, slow ? 'todo' : 'done',
        !slow ? null : device.devOptions === false ? ABOUT : slow < 3 ? `${slow} of 3 left` : null));
    }
    const todo = apps.filter(s => s.state === 'todo').map(s => s.card.entry.name);
    const left = { apps: todo.length, settings: steps.filter(s => s.kind !== 'app' && ['todo', 'waiting', 'reinstall'].includes(s.state)).length };
    const has = k => steps.some(s => s.key === k && ['todo', 'waiting', 'reinstall'].includes(s.state));
    const list2 = todo.length ? todo : [has('setup:home') && 'Home screen', has('setup:animations') && 'faster animations'].filter(Boolean);
    const text = list2.length > 1 ? list2.slice(0, -1).join(', ') + ' and ' + list2[list2.length - 1] : list2[0] || '';
    return { steps, left, blurb: text ? (todo.length ? text : text[0].toUpperCase() + text.slice(1)) + '.' : '' };
  }

  /** "4 apps, 2 settings", "1 app", "1 setting", or "" when nothing is left. */
  function leftText(left) {
    const n = (k, w) => left[k] ? `${left[k]} ${w}${left[k] === 1 ? '' : 's'}` : '';
    return [n('apps', 'app'), n('settings', 'setting')].filter(Boolean).join(', ');
  }

  /** Installs run one at a time: add() queues an id, next() starts the oldest, done() frees the slot. */
  class Queue {
    constructor() { this.waiting = []; this.running = null; }
    add(id) {
      if (id === this.running || this.waiting.includes(id)) return false;
      this.waiting.push(id);
      return true;
    }
    // next(defer): the oldest waiting id that is not `defer`; `defer` only when nothing else waits (the toolbox updates itself last).
    next(defer) {
      if (this.running !== null || !this.waiting.length) return null;
      const i = this.waiting.findIndex(id => id !== defer);
      return (this.running = this.waiting.splice(i < 0 ? 0 : i, 1)[0]);
    }
    done(id) { if (id === this.running) this.running = null; }
    get busy() { return this.running !== null; }
  }

  const Store = { pickFile, cardState, label, oldFound, buildList, setupSteps, leftText, PROJECTIVY, Queue };
  if (typeof module === 'object') module.exports = Store; else window.Store = Store;
})();
