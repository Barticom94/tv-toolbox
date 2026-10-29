// Offline check of assets/ui/tools.js. Run from the repo root: node tools/check_tools.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { topMemory, appSizes, parseUserApps, closable, rowState, blame, aioMessage, dnsVerdict, healthConfig, pingAvg } = require('../assets/ui/tools.js');

const eq = (name, got, want) => { assert.deepStrictEqual(got, want, name); console.log('PASS ' + name); };
const ok = (name, cond) => { assert.ok(cond, name); console.log('PASS ' + name); };

// memory: the PSS table, not the RSS table Android 14 prints first
const mem = readFileSync('tools/fixtures/meminfo.txt', 'utf8');
ok('fixture has an RSS table before the PSS one', mem.indexOf('Total RSS by process:') < mem.indexOf('Total PSS by process:'));
eq('pss not rss', topMemory(mem, 1)[0].name, 'com.nuvio.tv');          // its PSS line, not its RSS line
ok('pss value', topMemory(mem, 1)[0].kb === Number(/([\d,]+)K: com\.nuvio\.tv/.exec(mem.split('Total PSS by process:')[1])[1].replace(/,/g, '')));
ok('pss is not the rss figure', topMemory(mem, 1)[0].kb !== Number(/([\d,]+)K: com\.nuvio\.tv/.exec(mem)[1].replace(/,/g, '')));
eq('n limits the list', topMemory(mem, 3).length, 3);
ok('biggest first', topMemory(mem, 50).every((m, i, a) => i === 0 || a[i - 1].kb >= m.kb));
ok('stops at the end of the table', !topMemory(mem, 500).some(m => /RAM/.test(m.name)));
eq('garbage dumpsys', topMemory('not dumpsys output', 10), []);
eq('header but no rows', topMemory('Total PSS by process:\n\nTotal RAM: 1K', 10), []);
eq('process name with a suffix', topMemory('Total PSS by process:\n    1,234K: com.a.b:svc (pid 9 / activities)\n', 5), [{ name: 'com.a.b:svc', kb: 1234 }]);

// storage
const sizes = appSizes(readFileSync('tools/fixtures/diskstats.txt', 'utf8'));
ok('sizes read', sizes.length > 0 && sizes.every(s => s.pkg && [s.app, s.data, s.cache, s.total].every(Number.isFinite)));
ok('sorted biggest first', sizes.every((s, i) => i === 0 || sizes[i - 1].total >= s.total));
ok('nuvio is in the list', sizes.some(s => s.pkg === 'com.nuvio.tv'));
eq('total is app + data (data already holds the cache)', appSizes('Package Names: ["a"]\nApp Sizes: [100]\nApp Data Sizes: [30]\nCache Sizes: [20]'), [{ pkg: 'a', app: 100, data: 30, cache: 20, total: 130 }]);
eq('diskstats length mismatch', appSizes('Package Names: ["a","b"]\nApp Sizes: [1]\nApp Data Sizes: [1,2]\nCache Sizes: [1,2]'), []);
eq('diskstats array missing', appSizes('Package Names: ["a"]\nApp Sizes: [1]\nApp Data Sizes: [1]'), []);
eq('diskstats array not json', appSizes('Package Names: ["a"]\nApp Sizes: [1]\nApp Data Sizes: [1]\nCache Sizes: [oops'), []);
eq('diskstats garbage', appSizes('nothing here'), []);

// which apps to close
eq('user apps', parseUserApps('package:com.nuvio.tv\npackage:com.spotify.tv.android\n'), ['com.nuvio.tv', 'com.spotify.tv.android']);
eq('user apps ignore blank and odd lines, CRLF', parseUserApps('package:a.b\r\n\r\nWarning: x\r\npackage:c.d\r\n'), ['a.b', 'c.d']);
eq('closable', closable(['b.app', 'com.nuvio.tv', 'a.app'], ['com.nuvio.tv']), ['a.app', 'b.app']);
eq('closable with nothing kept', closable(['b', 'a'], []), ['a', 'b']);

// health row colours
eq('green', rowState({ code: 200, ms: 300 }), 'green');
eq('slow', rowState({ code: 200, ms: 2500 }), 'amber');
eq('exactly 2 s is slow', rowState({ code: 200, ms: 2000 }), 'amber');
eq('degraded', rowState({ code: 200, ms: 100, reported: 'degraded' }), 'amber');
eq('maintenance', rowState({ code: 200, ms: 100, reported: 'maintenance' }), 'amber');
eq('downtime', rowState({ code: 200, ms: 100, reported: 'downtime' }), 'red');
eq('outage', rowState({ code: 200, ms: 100, reported: 'outage' }), 'red');
eq('operational is green', rowState({ code: 200, ms: 100, reported: 'operational' }), 'green');
eq('no answer', rowState({ code: 0, ms: 8000 }), 'red');
eq('server error', rowState({ code: 500, ms: 100 }), 'red');
eq('400 is red', rowState({ code: 400, ms: 100 }), 'red');
eq('unreadable', rowState({ code: -1, ms: 100 }), 'grey');
eq('unreadable beats a slow time', rowState({ code: -1, ms: 9000 }), 'grey');
eq('blame network', blame({ code: 0, kind: 'service' }), 'No answer. See Network check.');
eq('blame network beats yours', blame({ code: 0, kind: 'yours' }), 'No answer. See Network check.');
eq('blame yours', blame({ code: 500, kind: 'yours' }), 'Your add-on or Worker.');
eq('blame theirs', blame({ code: 503, kind: 'service' }), 'Their side. Nothing to fix here.');
eq('blame theirs: reported outage', blame({ code: 200, ms: 50, reported: 'outage', kind: 'nuvio-app' }), 'Their side. Nothing to fix here.');
eq('no blame on green', blame({ code: 200, ms: 100, kind: 'yours' }), null);
eq('no blame on amber', blame({ code: 200, ms: 5000, kind: 'yours' }), null);
eq('no blame on grey', blame({ code: -1, ms: 0, kind: 'service' }), null);

// AIOStreams errors
eq('aio 400', aioMessage(400), 'The link details are wrong.');
eq('aio 401', aioMessage(401), "The server's access key changed. Re-save the config.");
eq('aio 500', aioMessage(500), "The server couldn't build the add-on.");
eq('aio other', aioMessage(404), null);
eq('aio ok', aioMessage(200), null);

// DNS
eq('pihole block', dnsVerdict(['0.0.0.0'], ['140.82.121.4']), 'blocked');
eq('pihole block (v6 null)', dnsVerdict(['::'], ['140.82.121.4']), 'blocked');
eq('pihole block (both nulls)', dnsVerdict(['0.0.0.0', '::'], ['140.82.121.4']), 'blocked');
eq('pihole block (java v6 spelling)', dnsVerdict(['0.0.0.0', '0:0:0:0:0:0:0:0'], ['140.82.121.4']), 'blocked');
eq('pihole block (::0)', dnsVerdict(['::0'], ['140.82.121.4']), 'blocked');
eq('pihole block (padded zeros)', dnsVerdict(['0000:0000:0000:0000:0000:0000:0000:0000', '00.0.0.0'], ['140.82.121.4']), 'blocked');
eq('real v6 is not a block', dnsVerdict(['2606:4700::1111'], ['140.82.121.4']), 'ok');
eq('loopback is not a block', dnsVerdict(['127.0.0.1'], ['140.82.121.4']), 'ok');
eq('system empty, doh answers', dnsVerdict([], ['140.82.121.4']), 'blocked');
eq('dns ok', dnsVerdict(['140.82.121.4'], ['140.82.121.4']), 'ok');
eq('dns ok when doh is unreachable', dnsVerdict(['140.82.121.4'], []), 'ok');
eq('null and a real address is ok', dnsVerdict(['0.0.0.0', '140.82.121.4'], ['140.82.121.4']), 'ok');
eq('dns failed', dnsVerdict([], []), 'failed');
eq('pihole block when doh is unreachable too', dnsVerdict(['0.0.0.0'], []), 'blocked');
eq('v6 null block when doh is unreachable too', dnsVerdict(['0.0.0.0', '::'], []), 'blocked');

// health.json
eq('health config missing', healthConfig(null), { checks: [], error: 'missing' });
eq('health config invalid', healthConfig('{not json'), { checks: [], error: 'invalid' });
eq('health config: no checks array', healthConfig('{"checks": 3}'), { checks: [], error: 'invalid' });
eq('health config: not an object', healthConfig('[1,2]'), { checks: [], error: 'invalid' });
eq('health config: null json', healthConfig('null'), { checks: [], error: 'invalid' });
eq('health config empty list is fine', healthConfig('{"checks": []}'), { checks: [], error: null });
eq('health config drops http and bad types', healthConfig(JSON.stringify({ checks: [
  { name: 'A', type: 'http', url: 'https://a/health' }, { name: 'B', type: 'http', url: 'http://b' }, { name: 'C', type: 'ftp', url: 'https://c' }] })).checks.map(c => c.name), ['A']);
eq('health config keeps every good type, url or base', healthConfig(JSON.stringify({ checks: [
  { name: 'A', type: 'http', url: 'https://a/health' }, { name: 'M', type: 'manifest', url: 'https://m/manifest.json' },
  { name: 'X', type: 'aiostreams', base: 'https://x/stremio/uuid/key' }] })).checks.map(c => c.name), ['A', 'M', 'X']);
eq('health config drops no name, no address, junk entries', healthConfig(JSON.stringify({ checks: [
  { type: 'http', url: 'https://a' }, { name: 'B', type: 'http' }, { name: 'C', type: 'http', url: 'not a url' }, { name: '', type: 'http', url: 'https://d' },
  { name: 'E', type: 'http', url: 5 }, null, 7, 'x', { name: 'F', type: 'http', url: 'https://f' }] })).checks.map(c => c.name), ['F']);
eq('health config passes the good check through', healthConfig(JSON.stringify({ checks: [{ name: 'A', type: 'http', url: 'https://a/h' }] })).checks, [{ name: 'A', type: 'http', url: 'https://a/h' }]);

// ping
eq('ping avg', pingAvg('rtt min/avg/max/mdev = 1.1/2.5/4.0/0.3 ms'), 2.5);
eq('ping avg inside a full ping output', pingAvg('PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.\n64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=9.1 ms\n\n--- 1.1.1.1 ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss, time 2003ms\nrtt min/avg/max/mdev = 8.9/9.40/10.2/0.5 ms\n'), 9.4);
eq('ping: toybox style summary', pingAvg('round-trip min/avg/max = 1.0/3.5/6.0 ms'), 3.5);
eq('ping: everything lost', pingAvg('3 packets transmitted, 0 received, 100% packet loss, time 2050ms'), null);
eq('ping: nothing', pingAvg(''), null);
eq('ping: null', pingAvg(null), null);
