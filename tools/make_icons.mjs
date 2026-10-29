// TV Toolbox's launcher icon (96 px) and TV banner (320x180): an amber toolbox on a dark plate, with the name set in the
// bundled Atkinson Hyperlegible Next. Drawn as SVG in HTML and screenshot by headless Edge at the exact sizes.
// Run: node tools/make_icons.mjs [--tmp <dir>]   (writes res/, then a check sheet at 48 px and 160x90 into the temp dir)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TMP = process.argv.includes('--tmp') ? process.argv[process.argv.indexOf('--tmp') + 1] : tmpdir();
const FONT = readFileSync(join(ROOT, 'assets/ui/fonts/AtkinsonHyperlegibleNext.ttf')).toString('base64');
// The three colours of the look. The Apps/Tools screens reuse them (Task 7).
const PLATE = '#12202B', INK = '#F4F6FA', AMBER = '#F2B134';

const page = (w, h, svg) => `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: C; src: url(data:font/ttf;base64,${FONT}) format('truetype'); font-weight: 200 800; }
html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: transparent; }
svg { display: block; } text { font-family: C; font-weight: 800; }
</style><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${svg}</svg>`;

// The toolbox: a handle arch over an amber body split by a dark seam, with a latch. w = body width; the mark is 0.78 w tall.
// label: letters cut into the body (the icon has them; the banner has the name underneath instead).
const toolbox = (cx, top, w, label = '') => {
  const x = cx - w / 2, h = 0.78 * w, bodyTop = top + 0.2 * w, bodyH = h - 0.2 * w, r = 0.09 * w, sw = 0.09 * w;
  const hx = cx - 0.2 * w, hw = 0.4 * w;                       // handle: the outline's centre line
  return `<path d="M${hx} ${bodyTop + 0.02 * w} V${top + sw / 2 + 0.04 * w} Q${hx} ${top + sw / 2} ${hx + 0.06 * w} ${top + sw / 2}`
    + ` H${hx + hw - 0.06 * w} Q${hx + hw} ${top + sw / 2} ${hx + hw} ${top + sw / 2 + 0.04 * w} V${bodyTop + 0.02 * w}"`
    + ` fill="none" stroke="${AMBER}" stroke-width="${sw}" stroke-linejoin="round"/>`
    + `<rect x="${x}" y="${bodyTop}" width="${w}" height="${bodyH}" rx="${r}" fill="${AMBER}"/>`
    + `<rect x="${x}" y="${bodyTop + 0.2 * w}" width="${w}" height="${0.05 * w}" fill="${PLATE}"/>`
    + `<rect x="${cx - 0.07 * w}" y="${bodyTop + 0.155 * w}" width="${0.14 * w}" height="${0.14 * w}" rx="${0.03 * w}" fill="${PLATE}"/>`
    + (label ? `<text x="${cx}" y="${bodyTop + bodyH - 0.1 * w}" text-anchor="middle" fill="${PLATE}" style="font-size:${0.3 * w}px">${label}</text>` : '');
};

const ICON = page(96, 96, `<rect width="96" height="96" rx="18" fill="${PLATE}"/>` + toolbox(48, 20, 72, 'TV'));
const BANNER = page(320, 180, `<rect width="320" height="180" fill="${PLATE}"/>` + toolbox(160, 20, 76)
  + `<text x="160" y="152" text-anchor="middle" fill="${INK}" style="font-size:46px">TV Toolbox</text>`);

const profile = mkdtempSync(join(TMP, 'toolbox-icons-'));
const edge = spawn(EDGE, ['--headless=new', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--force-color-profile=srgb', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let port = null;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100);
  try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
}
if (!port) { edge.kill(); throw new Error('Edge did not start'); }
const ws = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data), p = pending.get(m.id);
  if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

/** Renders html at exactly w x h CSS px, DPR 1, on a transparent ground; returns the PNG. font: the page must use C. */
async function shot(html, w, h, font = true) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await S('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const { frameTree } = await S('Page.getFrameTree');
  await S('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
  const r = await S('Runtime.evaluate', { expression: `document.fonts.load('800 20px C').then(f => f.length)`, awaitPromise: true, returnByValue: true });
  if (font && r.result.value !== 1) throw new Error('the bundled font did not load: the PNG would use a fallback');
  await S('Runtime.evaluate', { expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true });
  const { data } = await S('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  await send('Target.closeTarget', { targetId });
  return Buffer.from(data, 'base64');
}

try {
  const icon = await shot(ICON, 96, 96), banner = await shot(BANNER, 320, 180);
  writeFileSync(join(ROOT, 'res/mipmap-xhdpi/ic_launcher.png'), icon);
  writeFileSync(join(ROOT, 'res/drawable-xhdpi/banner.png'), banner);
  // The check sheet: both at launcher sizes (48 px, 160x90) and full size, on a launcher-dark ground.
  const img = (png, w, h) => `<img src="data:image/png;base64,${png.toString('base64')}" width="${w}" height="${h}">`;
  const sheet = `<!doctype html><style>body{margin:0;padding:24px;background:#1F1F1F;display:flex;gap:24px;align-items:center}</style>`
    + img(icon, 48, 48) + img(icon, 96, 96) + img(banner, 160, 90) + img(banner, 320, 180);
  const out = join(TMP, 'toolbox-icons-check.png');
  writeFileSync(out, await shot(sheet, 760, 228, false));
  console.log(`icon and banner written; check sheet: ${out}`);
} finally {
  // msedge.exe relaunches itself, so the spawned PID is only a launcher: close the real browser over DevTools.
  await send('Browser.close').catch(() => {});
  ws.close();
  await sleep(1500);
  if (edge.exitCode === null) edge.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
