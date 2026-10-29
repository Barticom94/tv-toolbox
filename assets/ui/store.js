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

  /** Badge and buttons for a card. Copy is the Task 7 table. */
  function label(entry, state, installed, device) {
    const open = { act: 'open', text: 'Open' };
    switch (state) {
      case 'install': return { badge: null, buttons: [{ act: 'install', text: 'Install' }] };
      case 'update': {
        const file = fileFor(entry, device) || {};
        return { badge: `Update: ${installed.name} → ${fileName(entry, file)}`, buttons: [{ act: 'install', text: 'Update' }] };
      }
      case 'open': case 'newer':
        // An app with no launcher activity gets no Open button, rather than a button that does nothing.
        if (!installed.launch) return { badge: 'Installed', buttons: [] };
        return { badge: state === 'newer' ? 'Newer than the store' : null, buttons: [open] };
      case 'foreign': return { badge: 'Installed from another store', buttons: [{ act: 'keep', text: 'Keep it' }, { act: 'swap', text: 'Swap it' }] };
      case 'off': return { badge: device.fireTv ? 'Turned off. Amazon may have blocked it.' : 'Turned off', buttons: [] };
      default: return { badge: "Doesn't work on this TV", buttons: [] };
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

  /** Installs run one at a time: add() queues an id, next() starts the oldest, done() frees the slot. */
  class Queue {
    constructor() { this.waiting = []; this.running = null; }
    add(id) {
      if (id === this.running || this.waiting.includes(id)) return false;
      this.waiting.push(id);
      return true;
    }
    next() { return this.running === null && this.waiting.length ? (this.running = this.waiting.shift()) : null; }
    done(id) { if (id === this.running) this.running = null; }
    get busy() { return this.running !== null; }
  }

  const Store = { pickFile, cardState, label, oldFound, buildList, Queue };
  if (typeof module === 'object') module.exports = Store; else window.Store = Store;
})();
