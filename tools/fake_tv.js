// A stand-in for the Java bridge, for desktop previews: assets/ui/index.html?fake loads it when window.TV is missing.
// Not in the APK (build.sh packs assets/ only), so the TV never loads it. Sample apps are the public ones from apps.json
// plus two made-up examples, together covering every row state.
// Query words: setup (can't install yet), fire (a Fire TV), offline (saved copy), nocopy (offline, nothing saved),
// empty (an empty store), tools (Tools approved), hold (installs wait for app.onProgress/onInstalled from the console),
// nofile / badfile (health.json missing / not JSON), wired (Ethernet in the network check), vpn (a VPN is on in the network
// check), neterror (the network check breaks), theme=<name> (a design study from design/themes/).
// Tools answers read tools/fixtures/ with fetch, so a Tools preview needs a server whose CSP allows connect-src 'self'
// (the APK's CSP allows no connections, and the APK never loads this file).
// Every bridge call is recorded in TV.log.
(function () {
  if (window.TV) return;
  // ?theme=<name>: a design study from design/themes/<name>/ (its style.css, and its theme.js when it has one) replaces the app's look.
  const theme = (/[?&]theme=([\w-]+)/.exec(location.search) || [])[1];
  if (theme) {
    document.querySelector('link[rel=stylesheet]').href = `../../design/themes/${theme}/style.css`;
    const t = document.createElement('script');
    t.src = `../../design/themes/${theme}/theme.js`;
    t.onerror = () => t.remove();
    document.head.appendChild(t);
  }
  const has = w => new RegExp('[?&]' + w + '(&|=|$)').test(location.search);
  const SIGNER = 'a'.repeat(64), OTHER = 'b'.repeat(64), SELF = 'local.adam.tvtoolbox';
  const icon = (bg, fg) => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">'
    + `<rect width="96" height="96" rx="20" fill="${bg}"/><circle cx="48" cy="48" r="26" fill="${fg}"/></svg>`);
  const entry = (id, name, blurb, pkg, versionName, versionCode, more) => Object.assign({ id, name, blurb, package: pkg, versionName,
    versionCode, minSdk: 24, signer: SIGNER, files: [{ abi: 'universal', url: `https://example.invalid/${id}.apk`, size: 1 << 20,
    sha256: 'c'.repeat(64), versionCode, versionName }] }, more);
  const ICON = id => `https://barticom94.github.io/tv-toolbox/icons/${id}.png`;
  const apps = [
    entry('nuvio', 'Nuvio', 'Films, series and live TV.', 'com.nuvio.tv', '1.0.0', 1062, { icon: ICON('nuvio') }),
    entry('smarttube', 'SmartTube', 'YouTube without the ads.', 'org.smarttube.stable', '32.68', 2168,
      { icon: ICON('smarttube'), replaces: ['com.teamsmart.videomanager.tv', 'com.liskovsoft.smarttubetv.beta'] }),
    entry('snug', 'Snug', 'Live sport and sports channels.', 'local.adam.streamedtv', '1.0.40', 40, { icon: ICON('snug') }),
    entry('telly', 'Telly', 'Live UK TV with a Sky-style guide.', 'local.adam.telly', '1.0.2', 2, { icon: ICON('telly') }),
    entry('songsterr-tv', 'Songsterr TV', 'Guitar tabs that scroll along with the song.', 'local.adam.tabremote', '0.1.35', 35,
      { icon: ICON('songsterr-tv') }),
    entry('projectivy', 'Projectivy', 'A simpler home screen with just your apps.', 'com.spocky.projengmenu', '4.72', 472, { icon: ICON('projectivy') }),
    entry('example-off', 'Example Radio', 'A made-up app that is turned off.', 'com.example.radio', '2.0', 20),
    entry('example-new', 'Example Games', 'A made-up app that needs a newer TV.', 'com.example.games', '5.1', 51, { minSdk: 35 }),
    entry('nuvio-beta', 'Nuvio (beta)', "Nuvio's newest test build.", 'com.nuvio.tv', '1.1.0-beta.9', 1080, { hidden: true, icon: ICON('nuvio-beta') }),
    entry('toolbox', 'TV Toolbox', 'The toolbox itself.', SELF, '1.0.20', 20, { hidden: true, icon: ICON('toolbox') }),
  ];
  const inst = (name, code, more) => Object.assign({ code, name, enabled: true, signer: SIGNER, launch: true }, more);
  const installed = {
    'com.nuvio.tv': inst('1.1.0-beta.8', 1071),                         // newer than stable, an update for the beta
    'org.smarttube.stable': inst('32.47', 2147),                        // update
    'com.teamsmart.videomanager.tv': inst('6.0', 600),                  // SmartTube's old package
    'local.adam.telly': inst('1.0.2', 2, { signer: OTHER }),            // from another store
    'local.adam.tabremote': inst('0.1.34', 34),                         // update
    'com.spocky.projengmenu': inst('4.72', 472, { launch: false }),     // nothing to open (stands in for a screensaver)
    'com.example.radio': inst('2.0', 20, { enabled: false }),           // turned off
    [SELF]: inst('1.0.19', 19),                                         // the toolbox: one behind
  };
  const savedAt = new Date(2026, 9, 29, 18, 20).getTime();
  const answer = () => JSON.parse(JSON.stringify({
    catalog: has('nocopy') ? null : { generated: '2026-10-29T18:20:00Z', apps: has('empty') ? [] : apps },
    savedAt: has('nocopy') ? null : savedAt, offline: has('offline') || has('nocopy'), installed }));
  const later = (fn, ms) => setTimeout(fn, ms || 30);
  const log = [];

  // ---- Tools: the fixtures, plus made-up hosts under example.com and documentation addresses (RFC 5737) ----
  const fixture = name => fetch('../../tools/fixtures/' + name).then(r => r.text()).catch(() => '');
  const KB = 1024, MB = 1e6, VPN = 'com.example.vpn';   // a made-up VPN app: Close background apps must never stop it
  let freed = 0, free = 18759292 * KB, expiryOff = false, keep = null;
  const ping = (ip, avg) => `PING ${ip} (${ip}) 56(84) bytes of data.\n\n--- ${ip} ping statistics ---\n`
    + `5 packets transmitted, 5 received, 0% packet loss, time 4006ms\nrtt min/avg/max/mdev = ${(avg * .8).toFixed(3)}/${avg.toFixed(3)}/${(avg * 1.3).toFixed(3)}/0.210 ms\n`;
  const tools = {
    meminfo: async () => ({ text: await fixture('meminfo.txt'), total: 3962200 * KB, avail: 1646238 * KB + freed }),
    userApps: () => ({ text: Object.keys(installed).concat(VPN).map(p => 'package:' + p).join('\n') + '\n' }),
    vpnApps: () => ({ apps: [VPN] }),
    killAll: () => { freed += 180 * MB; return { text: '' }; },
    stopApp: () => { freed += 45 * MB; return { text: '' }; },
    forceStop: () => ({ text: '' }),
    diskstats: async () => ({ text: await fixture('diskstats.txt'), free }),
    trimCaches: () => { const before = free; free += 412 * MB; return { before, after: free }; },
    clearCache: () => { free += 60 * MB; return { text: 'Success' }; },
    reboot: () => ({ text: '' }),
    expiryGet: () => ({ text: expiryOff ? '0' : 'null' }),
    expiryOff: () => { expiryOff = true; return { text: '' }; },
    home: () => ({ text: 'com.google.android.apps.tv.launcherx' }),
    ime: () => ({ text: 'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME' }),
    ping: arg => ({ text: ping(arg === 'gateway' ? '192.0.2.1' : '1.1.1.1', 2.4) }),
  };
  const HEALTH = JSON.stringify({ checks: [
    { name: 'My add-on', type: 'manifest', url: 'https://addon.example.com/manifest.json' },
    { name: 'AIOStreams', type: 'aiostreams', base: 'https://aio.example.com' },
    { name: 'Subtitles Worker', type: 'http', url: 'https://worker.example.com/health' },
    { name: 'Old add-on', type: 'http', url: 'http://old.example.com/' },          // not https: healthConfig drops it
  ] });
  // One of each colour: green, amber (degraded, slow), red (outage, 401, no answer), grey (unreadable).
  const BUILT_IN = [
    { name: 'Nuvio app', kind: 'nuvio-app', host: null, code: 200, ms: 0, reported: 'degraded',
      detail: '1.1.0-beta.8 installed · newest beta 1.1.0-beta.9 · newest stable 1.0.0' },
    { name: 'Nuvio sign-in', kind: 'service', host: 'status.nuvio.tv', code: 200, ms: 240, reported: 'operational', detail: '' },
    { name: 'Nuvio sync', kind: 'service', host: 'status.nuvio.tv', code: 200, ms: 262, reported: 'operational', detail: '' },
    { name: 'TorBox', kind: 'service', host: 'status.torbox.app', code: 200, ms: 318, reported: 'outage', detail: '' },
    { name: 'TorBox (independent monitor)', kind: 'service', host: 'status.stremio-status.com', code: -1, ms: 410, reported: null, detail: '' },
    { name: 'Cinemeta (independent monitor)', kind: 'service', host: 'status.stremio-status.com', code: 200, ms: 2630, reported: 'operational', detail: '' },
  ];
  const YOURS = { 'My add-on': [200, 180], AIOStreams: [401, 350], 'Subtitles Worker': [0, 30000] };

  window.TV = {
    log,
    device: () => JSON.stringify({ sdk: 34, abis: ['armeabi-v7a', 'armeabi'], fireTv: has('fire'), canInstall: !has('setup'), healthFile: !has('nofile'),
                                   self: SELF, version: '1.0.19' }),
    loadCatalog() { log.push('loadCatalog'); later(() => app.onCatalog(answer())); },
    install(id, abi) {
      log.push(`install ${id} ${abi}`);
      if (has('hold')) return;
      const e = apps.find(a => a.id === id);
      let pct = 0;
      const tick = () => {
        app.onProgress(id, pct);
        if (pct < 100) { pct += 20; later(tick, 80); return; }
        installed[e.package] = inst(e.versionName, e.versionCode);
        later(() => app.onInstalled(id, true, ''), 300);
      };
      later(tick);
    },
    uninstall(pkg) { log.push('uninstall ' + pkg); delete installed[pkg]; later(() => app.onResume(), 200); },
    open(pkg) { log.push('open ' + pkg); },
    openInstallSettings() { log.push('openInstallSettings'); return true; },
    nudge() { log.push('nudge'); },

    tool(name, arg) {
      log.push(arg == null ? 'tool ' + name : `tool ${name} ${arg}`);
      const f = tools[name];
      later(async () => app.onResult(name, f ? Object.assign({ ok: true }, await f(arg)) : { ok: false, error: 'Unknown tool' }));
    },
    keepList() { return keep; },
    setKeepList(json) {
      log.push('setKeepList ' + json);
      try {
        const a = JSON.parse(json);
        if (Array.isArray(a) && a.every(p => typeof p === 'string' && /^[A-Za-z0-9_.]+$/.test(p))) keep = JSON.stringify(a);
      } catch (e) { /* refused: the old list stands */ }
      return keep;
    },
    healthText() { return has('nofile') ? null : has('badfile') ? '{"checks": [' : HEALTH; },
    health(json) {
      log.push('health ' + json);
      const rows = BUILT_IN.concat(JSON.parse(json).map(c => {
        const a = YOURS[c.name] || [200, 150];
        return { name: c.name, kind: 'yours', host: new URL(c.url || c.base).hostname, code: a[0], ms: a[1], reported: null, detail: '' };
      }));
      rows.reverse().forEach((r, i) => later(() => app.onHealthRow(r), 60 + 40 * i));   // out of order, as parallel checks finish
      later(() => app.onResult('healthDone', {}), 120 + 40 * rows.length);
    },
    network(json) {
      log.push('network ' + json);
      const ip = '203.0.113.10', lookups = JSON.parse(json).concat(['status.nuvio.tv', 'status.torbox.app', 'status.stremio-status.com',
        'barticom94.github.io', 'github.com', 'release-assets.githubusercontent.com']).map(host =>
        host === 'aio.example.com' ? { host, system: ['0.0.0.0'], doh: [ip] }                 // a blocker answers 0.0.0.0
          : host === 'worker.example.com' ? { host, system: [], doh: [] } : { host, system: [ip], doh: [ip] });
      if (has('neterror')) {
        later(() => app.onResult('network', { error: true, type: 'other', wifi: null, dns: [], privateDns: { active: false, name: null },
          gateway: null, ping: { gateway: null, internet: null }, speedMbps: null, lookups: [] }), 400);
        return;
      }
      later(() => app.onResult('network', { type: has('wired') ? 'ethernet' : 'wifi', vpn: has('vpn'), wifi: has('wired') ? null : { rssi: -58, mbps: 433 },
        dns: ['192.0.2.53'], privateDns: { active: false, name: null }, gateway: '192.0.2.1',
        ping: { gateway: ping('192.0.2.1', 2.405), internet: ping('1.1.1.1', 14.8) }, speedMbps: 87.4, lookups }), 400);
    },
  };
  if (has('tools')) later(() => app.onTools(true), 0);
})();
