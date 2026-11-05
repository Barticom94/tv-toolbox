// Offline check of assets/ui/store.js. Run from the repo root: node tools/check_store.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { pickFile, cardState, label, oldFound, buildList, Queue, setupSteps, leftText, PROJECTIVY } = require('../assets/ui/store.js');

const eq = (name, got, want) => { assert.deepStrictEqual(got, want, name); console.log('PASS ' + name); };

const dev = { sdk: 34, abis: ['armeabi-v7a', 'armeabi'], fireTv: false, canInstall: true, self: 'local.adam.tvtoolbox', a11yApps: [], animations: [1, 1, 1], devOptions: true, homeBlocked: false };
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

// queue: the toolbox's own update waits for the others
{ const q2 = new Queue(); q2.add('a'); q2.add('toolbox'); q2.add('b');
  eq('defer: a first', q2.next('toolbox'), 'a'); q2.done('a');
  eq('defer: then b', q2.next('toolbox'), 'b'); q2.done('b');
  eq('defer: toolbox last', q2.next('toolbox'), 'toolbox'); q2.done('toolbox');
  q2.add('toolbox'); eq('defer: only toolbox waiting', q2.next('toolbox'), 'toolbox'); }

// set up this TV
const P = 'com.spocky.projengmenu';
eq('PROJECTIVY', PROJECTIVY, P);
const se = (id, name, pkg) => ({ ...e, id, name, package: pkg, setup: true });
const nuvio = se('nuvio', 'Nuvio', 'com.nuvio.tv'), snug = se('snug', 'Snug', 'local.adam.streamedtv'),
      telly = se('telly', 'Telly', 'local.adam.telly'), proj = se('projectivy', 'Projectivy', P);
const allApps = [nuvio, snug, telly, proj];
const have = (...es) => Object.fromEntries(es.map(x => [x.package, inst()]));
const steps = (apps, installed, d) => setupSteps(buildList({ catalog: { apps }, installed }, d, false), d);
const states = r => r.steps.map(s => s.state);
const keys = r => r.steps.map(s => s.key);

const fresh = steps(allApps, {}, dev);
eq('fresh keys', keys(fresh), ['setup:nuvio', 'setup:snug', 'setup:telly', 'setup:projectivy', 'setup:home', 'setup:animations']);
eq('fresh states', states(fresh), ['todo', 'todo', 'todo', 'todo', 'waiting', 'todo']);
eq('fresh kinds', fresh.steps.map(s => s.kind), ['app', 'app', 'app', 'app', 'home', 'animations']);
eq('fresh left', fresh.left, { apps: 4, settings: 2 });
eq('fresh blurb', fresh.blurb, 'Nuvio, Snug, Telly and Projectivy.');
eq('fresh leftText', leftText(fresh.left), '4 apps, 2 settings');
eq('home waits with a reason', fresh.steps[4].detail, 'Install Projectivy first');
eq('app step carries its card', fresh.steps[0].card.id, 'nuvio');
eq('home and animations have no card', [fresh.steps[4].card, fresh.steps[5].card], [null, null]);
eq('projectivy first in the catalogue still last', keys(steps([proj, nuvio, snug, telly], {}, dev)).slice(0, 4), ['setup:nuvio', 'setup:snug', 'setup:telly', 'setup:projectivy']);
const fire = steps(allApps, {}, { ...dev, fireTv: true });
eq('fire tv: four app steps', keys(fire), ['setup:nuvio', 'setup:snug', 'setup:telly', 'setup:projectivy']);
eq('fire tv: no settings left', fire.left, { apps: 4, settings: 0 });

const allIn = have(...allApps);
const done = steps(allApps, allIn, { ...dev, a11yApps: [P], animations: [0.5, 0.5, 0] });
eq('all done states', states(done), ['done', 'done', 'done', 'done', 'done', 'done']);
eq('all done left', done.left, { apps: 0, settings: 0 });
eq('all done blurb', [done.blurb, leftText(done.left)], ['', '']);

const anim = (animations, extra = {}) => steps(allApps, allIn, { ...dev, a11yApps: [P], animations, ...extra }).steps[5];
eq('anim 2 left', [anim([0.5, 1, 1]).state, anim([0.5, 1, 1]).detail], ['todo', '2 of 3 left']);
eq('anim 1 left', anim([0.5, 0.5, 1.5]).detail, '1 of 3 left');
eq('anim all 3 left: no detail', anim([1, 1, 1]).detail, null);
eq('anim no dev options', anim([1, 1, 1], { devOptions: false }).detail, 'Settings › System › About: press Android TV OS build 7 times.');
eq('anim unreadable: no step', keys(steps(allApps, allIn, { ...dev, animations: null })).includes('setup:animations'), false);

const home = (d, installed = allIn, apps = allApps) => steps(apps, installed, { ...dev, animations: [0.5, 0.5, 0.5], ...d });
const h = r => r.steps.find(s => s.key === 'setup:home');
eq('home todo', [h(home({})).state, h(home({})).detail], ['todo', null]);
eq('home blocked', [h(home({ homeBlocked: true })).state, h(home({ homeBlocked: true })).detail], ['reinstall', 'Android blocks this copy']);
eq('service beats blocked', h(home({ homeBlocked: true, a11yApps: [P] })).state, 'done');
const foreign = { ...allIn, [P]: inst({ signer: 'bb' }) };
const hf = home({ homeBlocked: true }, foreign);
eq('foreign projectivy: app done, home reinstall', [hf.steps[3].state, h(hf).state], ['done', 'reinstall']);
const off = home({}, { ...allIn, [P]: inst({ enabled: false }) });
eq('projectivy off: app done, home skipped', [off.steps[3].state, h(off).state], ['done', 'skipped']);
const unsup = home({}, allIn, [nuvio, snug, telly, { ...proj, minSdk: 99 }]);
eq('projectivy unsupported: both skipped', [unsup.steps[3].state, h(unsup).state], ['skipped', 'skipped']);
eq('projectivy absent: no home step', h(home({}, allIn, [nuvio, snug, telly])), undefined);

const tu = steps([nuvio, snug, { ...telly, minSdk: 99 }, proj], {}, dev);
eq('telly unsupported', [tu.steps[2].state, tu.left.apps, tu.blurb], ['skipped', 3, 'Nuvio, Snug and Projectivy.']);
const plain = [{ ...e }, { ...e, id: 'snug', package: 'x' }];
eq('no setup flags: no steps', steps(plain, {}, dev), { steps: [], left: { apps: 0, settings: 0 }, blurb: '' });
eq('empty answer: no steps', setupSteps(buildList({}, dev), dev).steps, []);

const settingsOnly = steps(allApps, allIn, dev);
eq('settings only', [settingsOnly.left, settingsOnly.blurb, leftText(settingsOnly.left)], [{ apps: 0, settings: 2 }, 'Home screen and faster animations.', '2 settings']);
eq('blurb: home only', steps(allApps, allIn, { ...dev, animations: [0.5, 0.5, 0.5] }).blurb, 'Home screen.');
eq('blurb: animations only', steps(allApps, allIn, { ...dev, a11yApps: [P] }).blurb, 'Faster animations.');
eq('leftText singular', [leftText({ apps: 1, settings: 0 }), leftText({ apps: 0, settings: 1 })], ['1 app', '1 setting']);
eq('blurb: two apps', steps([nuvio, snug], {}, dev).blurb, 'Nuvio and Snug.');
eq('blurb: one app', steps([nuvio], {}, dev).blurb, 'Nuvio.');
