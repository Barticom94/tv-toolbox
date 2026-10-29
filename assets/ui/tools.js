// Pure Tools decisions: parse what the TV prints, pick what to show. Java supplies the text, this file decides.
// No DOM, no fetch, no dynamic code (the page runs under a strict CSP). Plain ES2017 so an older TV WebView runs it.
// Loads both ways: module.exports under node (tools/check_tools.mjs), window.Tools in the page.
(function () {
  const lines = text => String(text).split(/\r?\n/);
  const num = s => Number(String(s).replace(/,/g, ''));

  /** The biggest processes by PSS (what Android shares out fairly), from `dumpsys meminfo`. Android 14 prints an RSS table
   *  first, so only the `Total PSS by process:` section is read. Anything else gives []. */
  function topMemory(text, n) {
    const rows = [];
    let inside = false;
    for (const line of lines(text)) {
      if (!inside) { inside = /^Total PSS by process:/.test(line); continue; }
      const m = /^\s+([\d,]+)K: (.+?) \(pid \d+/.exec(line);
      if (m) rows.push({ name: m[2], kb: num(m[1]) });
      else if (rows.length || /\S/.test(line)) break;     // the table ended (or this isn't a table at all)
    }
    return rows.sort((a, b) => b.kb - a.kb).slice(0, n);
  }

  /** Per-app storage from `dumpsys diskstats`, biggest first. App data already includes the cache (the cache is never
   *  larger than it in a real capture), so total = app + data. [] when an array is missing, unreadable or a different length. */
  function appSizes(text) {
    const arr = key => {
      const m = new RegExp('^' + key + ': (.*)$', 'm').exec(String(text));
      try { const a = m && JSON.parse(m[1]); return Array.isArray(a) ? a : null; } catch (e) { return null; }
    };
    const names = arr('Package Names'), app = arr('App Sizes'), data = arr('App Data Sizes'), cache = arr('Cache Sizes');
    if (!names || !app || !data || !cache || [app, data, cache].some(a => a.length !== names.length)) return [];
    if (![app, data, cache].every(a => a.every(v => typeof v === 'number' && isFinite(v)))) return [];
    return names.map((pkg, i) => ({ pkg, app: app[i], data: data[i], cache: cache[i], total: app[i] + data[i] }))
      .sort((a, b) => b.total - a.total);
  }

  /** Package names from `pm list packages -3` (`package:com.example.app` lines). */
  const parseUserApps = text => lines(text).map(l => /^package:([A-Za-z0-9_.]+)\s*$/.exec(l)).filter(Boolean).map(m => m[1]);

  /** The user apps Close background apps may stop: everything except the keep list and `never` (the VPN apps and this app,
   *  whatever the keep list says), in a steady order. */
  function closable(userApps, keep, never) {
    const kept = new Set(keep.concat(never || []));
    return userApps.filter(p => !kept.has(p)).sort();
  }

  /** diskstats' per-app sizes are Android's once-a-day count (/data/system/diskstats_cache.json), so a clear never shows in them
   *  by reading again. These sizes with the caches this page cleared taken off; `cleared` holds package names, '*' for every app.
   *  ponytail: kept for the page's life; if Android counts again meanwhile, a fresh small cache is zeroed too. */
  function lessCleared(sizes, cleared) {
    const all = cleared.includes('*');
    return sizes.map(s => all || cleared.includes(s.pkg) ? Object.assign({}, s, { data: s.data - s.cache, cache: 0, total: s.total - s.cache }) : s)
      .sort((a, b) => b.total - a.total);
  }

  /** A health row's colour. Unreadable is grey; the worst thing wrong decides between red and amber. */
  function rowState(row) {
    const { code, ms, reported } = row;
    if (code === -1) return 'grey';
    if (reported === 'outage' || reported === 'downtime' || code === 0 || code >= 400) return 'red';
    if (reported === 'degraded' || reported === 'maintenance' || ms >= 2000) return 'amber';
    return 'green';
  }

  /** Whose problem a red row is. Null for any other colour. */
  function blame(row) {
    if (rowState(row) !== 'red') return null;
    if (row.code === 0) return 'No answer. See Network check.';
    return row.kind === 'yours' ? 'Your add-on or Worker.' : 'Their side. Nothing to fix here.';
  }

  /** What an AIOStreams error code means in plain words. */
  function aioMessage(code) {
    switch (code) {
      case 400: return 'The link details are wrong.';
      case 401: return "The server's access key changed. Re-save the config.";
      case 500: return "The server couldn't build the add-on.";
      default: return null;
    }
  }

  // Any spelling of the unspecified address: 0.0.0.0, ::, ::0, 0:0:0:0:0:0:0:0 (what Java prints for the IPv6 one).
  const NULL_ADDR = /^(0+(\.0+){3}|[0:]*:[0:]*)$/;

  /** `blocked`: this TV's own DNS gave nothing real: only 0.0.0.0 / :: from a blocker (whatever DNS-over-HTTPS says), or nothing
   *  while DNS-over-HTTPS has an address. */
  function dnsVerdict(system, doh) {
    const sys = Array.isArray(system) ? system : [], over = Array.isArray(doh) ? doh : [];
    if (!sys.length && !over.length) return 'failed';
    const real = sys.filter(a => !NULL_ADDR.test(String(a).trim()));
    return real.length ? 'ok' : 'blocked';
  }

  const TYPES = ['http', 'manifest', 'aiostreams'];
  const isHttps = s => { try { return typeof s === 'string' && new URL(s).protocol === 'https:'; } catch (e) { return false; } };

  /** health.json, validated. Bad entries are dropped (the rest still run); the good ones are passed through unchanged, so Java reads
   *  `url` (or `base` for an AIOStreams link). `text` is null when the file is missing. */
  function healthConfig(text) {
    if (text === null || text === undefined) return { checks: [], error: 'missing' };
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return { checks: [], error: 'invalid' }; }
    if (!parsed || !Array.isArray(parsed.checks)) return { checks: [], error: 'invalid' };
    const good = c => !!c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim() !== ''
      && TYPES.includes(c.type) && isHttps(c.url !== undefined ? c.url : c.base);
    return { checks: parsed.checks.filter(good), error: null };
  }

  /** The average round trip in ms from a `ping` summary line, or null when there isn't one (every packet lost). */
  function pingAvg(text) {
    const m = /min\/avg\/max(?:\/mdev)? = [\d.]+\/([\d.]+)\//.exec(String(text));
    return m ? Number(m[1]) : null;
  }

  const NO_ANSWER = 'No answer from the TV. Try again.';

  /** Java's answers by name, oldest wait first: Java runs each kind in the order asked and sends no request id. A wait that
   *  gets nothing for `ms` ends with {ok:false, error: NO_ANSWER} but keeps its place, dead, so its late answer is swallowed
   *  instead of being handed to the next wait of that name. */
  class Waiters {
    constructor() { this.q = {}; }

    /** The next answer to `name`. Queued at once, so send the request after calling this. */
    wait(name, ms) {
      return new Promise(res => {
        const s = { dead: false, res };
        s.arm = () => { clearTimeout(s.t); s.t = setTimeout(() => { s.dead = true; res({ ok: false, error: NO_ANSWER }); }, ms); };
        s.arm();
        (this.q[name] = this.q[name] || []).push(s);
      });
    }

    /** Java answered `name`: the oldest wait gets it, or swallows it when that wait already gave up. */
    answer(name, r) {
      const s = (this.q[name] || []).shift();
      if (s && !s.dead) { clearTimeout(s.t); s.res(r || {}); }
    }

    /** Java is still at work on `name` (a health row came in): the oldest live wait's clock starts again. False when there is
     *  no wait or the oldest gave up, so what came in belongs to that one and is dropped. */
    alive(name) {
      const q = this.q[name] || [], live = q.find(s => !s.dead);
      if (live) live.arm();
      return q.length > 0 && !q[0].dead;
    }
  }

  const Tools = { topMemory, appSizes, parseUserApps, closable, lessCleared, rowState, blame, aioMessage, dnsVerdict, healthConfig, pingAvg,
    NO_ANSWER, Waiters };
  if (typeof module === 'object') module.exports = Tools; else window.Tools = Tools;
})();
