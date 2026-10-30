// Offline check of assets/ui/store.js. Run from the repo root: node tools/check_store.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { pickFile, cardState, label, oldFound, buildList, Queue } = require('../assets/ui/store.js');

const eq = (name, got, want) => { assert.deepStrictEqual(got, want, name); console.log('PASS ' + name); };

const dev = { sdk: 34, abis: ['armeabi-v7a', 'armeabi'], fireTv: false, canInstall: true, self: 'local.adam.tvtoolbox' };
const only64 = { ...dev, abis: ['arm64-v8a'] };
const e = { id: 'nuvio', name: 'Nuvio', package: 'com.nuvio.tv', versionName: '1.0.0', versionCode: 1062, minSdk: 24, signer: 'aa',
            files: [{ abi: 'armeabi-v7a', url: 'u1' }, { abi: 'universal', url: 'u2' }] };
const inst = (o = {}) => ({ code: 1062, name: '1.0.0', enabled: true, signer: 'aa', launch: true, ...o });

// which file this TV gets
eq('pick v7a', pickFile(e, dev), 'armeabi-v7a');
eq('pick universal on 64-bit-only', pickFile(e, only64), 'universal');
eq('pick nothing when no file fits', pickFile({ ...e, files: [{ abi: 'armeabi-v7a' }] }, only64), null);
eq('pick: v7a TV but entry has only universal', pickFile({ ...e, files: [{ abi: 'universal' }] }, dev), 'universal');
eq('pick: no abis reported', pickFile(e, { ...dev, abis: undefined }), 'universal');

// the card states, in spec order
eq('unsupported: old Android', cardState({ ...e, minSdk: 35 }, undefined, dev), 'unsupported');
eq('unsupported: no file for this TV', cardState({ ...e, files: [{ abi: 'armeabi-v7a' }] }, undefined, only64), 'unsupported');
eq('unsupported beats installed', cardState({ ...e, minSdk: 35 }, inst(), dev), 'unsupported');
eq('install', cardState(e, undefined, dev), 'install');
eq('off beats foreign', cardState(e, inst({ enabled: false, signer: 'bb' }), dev), 'off');
eq('foreign', cardState(e, inst({ signer: 'bb' }), dev), 'foreign');
eq('update', cardState(e, inst({ code: 1061 }), dev), 'update');
eq('open', cardState(e, inst(), dev), 'open');
eq('newer', cardState(e, inst({ code: 1071, name: '1.1.0-beta.8' }), dev), 'newer');

// per-file versions: ABI splits can be numbered differently
const split = { ...e, files: [{ abi: 'armeabi-v7a', url: 'u1', versionCode: 1062, versionName: '1.0.0' },
                              { abi: 'universal', url: 'u2', versionCode: 1063, versionName: '1.0.1' }] };
eq('split: 64-bit-only TV with 1062 sees update', cardState(split, inst(), only64), 'update');
eq('split: armeabi-v7a TV with 1062 sees open', cardState(split, inst(), dev), 'open');
eq('split: update detail names the picked file', label(split, 'update', inst({ name: '1.0.0' }), only64).detail, '1.0.0 → 1.0.1');
eq('split: file without a version uses the entry', cardState({ ...split, files: [{ abi: 'armeabi-v7a', url: 'u1' }] }, inst({ code: 1061 }), dev), 'update');

// what each row says and does
const row = (act, text, detail = null) => ({ act, text, detail });
eq('install label', label(e, 'install', undefined, dev), row('install', 'Install'));
eq('update label', label(e, 'update', inst({ code: 1061, name: '0.9.9' }), dev), row('install', 'Update', '0.9.9 → 1.0.0'));
eq('open label', label(e, 'open', inst(), dev), row('open', 'Open'));
eq('newer label', label(e, 'newer', inst({ code: 1071 }), dev), row('open', 'Open'));
eq('no launch activity', label(e, 'open', inst({ launch: false }), dev), row(null, 'Installed'));
eq('no launch activity, newer', label(e, 'newer', inst({ launch: false, code: 1071 }), dev), row(null, 'Installed'));
eq('foreign label', label(e, 'foreign', inst({ signer: 'bb' }), dev), row('swap', 'Swap', 'From another store'));
eq('unsupported label', label(e, 'unsupported', undefined, dev), row(null, 'Not for this TV'));
eq('off text', label(e, 'off', inst({ enabled: false }), dev), row(null, 'Turned off'));
eq('fire tv off text', label(e, 'off', inst({ enabled: false }), { ...dev, fireTv: true }).detail, 'Amazon may have blocked it');

// old versions under another package name
const re = { ...e, replaces: ['com.old.nuvio', 'com.older.nuvio'] };
eq('old found', oldFound(re, { installed: { 'com.old.nuvio': inst(), 'com.other': inst() } }), ['com.old.nuvio']);
eq('old found: none', oldFound(re, { installed: {} }), []);
eq('old found: entry replaces nothing', oldFound(e, { installed: { 'com.old.nuvio': inst() } }), []);
eq('old found: inherited names do not count', oldFound({ ...e, replaces: ['constructor'] }, { installed: {} }), []);

// the list
// bad entry is skipped: missing files, missing versionCode
const cat = { apps: [e, { ...e, id: 'x', files: [] }, { ...e, id: 'y', versionCode: undefined }, { ...e, id: 'h', hidden: true },
                     { ...e, id: 'toolbox', package: 'local.adam.tvtoolbox', hidden: true, versionCode: 5 }] };
eq('bad entry is skipped', buildList({ catalog: cat, installed: {} }, dev, false).cards.map(c => c.id), ['nuvio']);
eq("hidden group on Adam's TV", buildList({ catalog: cat, installed: {} }, dev, true).cards.map(c => [c.id, c.group || null]), [['nuvio', null], ['h', 'Only on your TV']]);
eq('bad hidden entry is skipped too', buildList({ catalog: { apps: [{ ...e, id: 'h', hidden: true, signer: undefined }] }, installed: {} }, dev, true).cards, []);
eq('garbage entries are skipped', buildList({ catalog: { apps: [null, 'x', 7, e] }, installed: {} }, dev, false).cards.map(c => c.id), ['nuvio']);
eq('self update', buildList({ catalog: cat, installed: { 'local.adam.tvtoolbox': inst({ code: 4 }) } }, dev, false).selfUpdate.id, 'toolbox');
eq('no self update when current', buildList({ catalog: cat, installed: { 'local.adam.tvtoolbox': inst({ code: 5 }) } }, dev, false).selfUpdate, null);
eq('no self update without a toolbox entry', buildList({ catalog: { apps: [e] }, installed: { 'local.adam.tvtoolbox': inst({ code: 4 }) } }, dev, false).selfUpdate, null);
const tbSplit = { ...cat.apps[4], files: [{ abi: 'armeabi-v7a', url: 'u1', versionCode: 5 }, { abi: 'universal', url: 'u2', versionCode: 6 }] };
const tbList = d => buildList({ catalog: { apps: [e, tbSplit] }, installed: { 'local.adam.tvtoolbox': inst({ code: 5 }) } }, d, false).selfUpdate;
eq('self update uses the picked file: 64-bit-only TV', tbList(only64) && tbList(only64).id, 'toolbox');
eq('self update uses the picked file: v7a TV', tbList(dev), null);
eq('null catalogue', buildList({ catalog: null, installed: {} }, dev, false).cards, []);
eq('empty answer', buildList({}, dev, true), { cards: [], selfUpdate: null, offline: false, savedAt: null });
eq('offline and saved copy date pass through', (({ offline, savedAt }) => ({ offline, savedAt }))(buildList({ catalog: cat, installed: {}, offline: true, savedAt: 1761760000000 }, dev, false)), { offline: true, savedAt: 1761760000000 });
const card = buildList({ catalog: { apps: [re] }, installed: { 'com.nuvio.tv': inst({ code: 1061, name: '0.9.9' }), 'com.old.nuvio': inst() } }, dev, false).cards[0];
eq('card carries its decisions', [card.id, card.state, card.act, card.text, card.detail, card.old], ['nuvio', 'update', 'install', 'Update', '0.9.9 → 1.0.0', ['com.old.nuvio']]);

// queue runs one at a time
const q = new Queue(); eq('add', q.add('a'), true); eq('dup', q.add('a'), false); q.add('b');
eq('idle until started', q.busy, false);
eq('next a', q.next(), 'a'); eq('busy', q.busy, true); eq('no second while busy', q.next(), null);
eq('running one cannot be added again', q.add('a'), false);
q.done('a'); eq('free after done', q.busy, false); eq('next b', q.next(), 'b'); q.done('b'); eq('next on empty', q.next(), null);
eq('can queue again once done', q.add('a'), true);
