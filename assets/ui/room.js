// The room: the focused app's icon lights the room round it (on Tools, the toolbox's own copper does). Decorative
// only: it adds the room behind the page, tints the band's shadow and marks a row whose install just finished. It never
// calls window.TV or window.app, never moves the focus, never changes text.
(function () {
  'use strict';
  const CAP = 0.085;                  // room luminance wherever Haze text can sit: Haze keeps 4.8:1
  const CAP_NAMES = 0.13;             // left of ZONE on Apps only icons and Moonlight names sit: 5.2:1, the band 3.1:1 against it
  const ZONE = 29;                    // vw: where the blurbs start (30.8vw) less a margin
  const CX = 7, W = 170;              // vw: a light's centre (the icon's) and width, as .light in style.css
  const VMAX = 0.62;                  // no channel past 158: saturated blue looks far brighter than its luminance says
  const SWELL = 1.15;                 // the landing's spread (@keyframes swell): the zones are checked at that size
  const NIGHT = '#0F1C26', NIGHT_RGB = [15, 28, 38];   // --surface: every light ends in it, so its edges vanish
  const FALLBACK = [74, 108, 140];    // an icon whose pixels can't be read: moonlight blue
  const FRESH = 20000;                // an install counts as just finished for this long after its row was last busy
  const LAMP_SHADE = 'rgba(26, 12, 4, .85)';
  const html = document.documentElement;

  function start() {
    const room = document.createElement('div'), lamp = document.createElement('canvas');
    room.className = 'room';
    room.setAttribute('aria-hidden', 'true');
    lamp.className = 'lamp on';
    drawLamp(lamp);
    room.append(lamp);
    document.body.prepend(room);

    const lights = {};                // icon url → its canvas, made once
    const busySince = {};             // data-key → when its row last showed an install running
    let lit = lamp, amber = null;                     // amber: the toolbox's own light (the lamp's copper hue), made on first use
    html.style.setProperty('--shade', LAMP_SHADE);

    const lin = v => (v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    const rgb = (c, f) => `rgb(${c.map(v => Math.round(v * f)).join(',')})`;

    /** The toolbox's lamp: pre-mixed opaque stops (amber to ember to night), so it never turns olive over the navy.
        Brightest stop #744611, luminance .081. Centred on the logo; 96x54 is the screen's shape, so the circle stays round. */
    function drawLamp(c) {
      c.width = 96; c.height = 54;
      const x = c.getContext('2d'), g = x.createRadialGradient(7, 3.5, 0, 7, 3.5, 84);
      [[0, '#744611'], [0.16, '#5E3313'], [0.38, '#3A2018'], [0.62, '#1D1E26'], [1, NIGHT]].forEach(s => g.addColorStop(s[0], s[1]));
      x.fillStyle = g;
      x.fillRect(0, 0, 96, 54);
      c.shade = LAMP_SHADE;
    }

    /** The icon's own colours: its pixels split into the two sides of their average hue, each side averaged with the most
        colourful pixels counting most (so a dark background or a white glyph doesn't grey it), then pushed to a clear hue.
        Two related hues light the core and the ring, the one further from the night's own blue in the core (Nuvio's logo
        runs blue to violet, and violet is what sets it apart). Unrelated hues: the heavier side only. */
    function accents(img) {
      const t = document.createElement('canvas'), x = t.getContext('2d');
      t.width = t.height = 16;
      x.drawImage(img, 0, 0, 16, 16);
      const d = x.getImageData(0, 0, 16, 16).data, px = [];
      let sx = 0, sy = 0;
      for (let i = 0; i < d.length; i += 4) {
        const c = [d[i], d[i + 1], d[i + 2]], w = Math.pow(Math.max(...c) - Math.min(...c), 2) * d[i + 3], h = hue(c);
        if (!w) continue;
        px.push({ c, w, h });
        sx += w * Math.cos(h); sy += w * Math.sin(h);
      }
      const mid = Math.atan2(sy, sx), sides = [[0, 0, 0, 0], [0, 0, 0, 0]];
      px.forEach(p => {
        const s = sides[Math.sin(p.h - mid) < 0 ? 0 : 1];
        for (let j = 0; j < 3; j++) s[j] += p.c[j] * p.w;
        s[3] += p.w;
      });
      const [a, b] = sides.filter(s => s[3]).sort((m, n) => n[3] - m[3]).map(s => vivid(s.slice(0, 3).map(v => v / s[3])));
      if (!a) return [FALLBACK, FALLBACK];
      const apart = b ? Math.cos(hue(a) - hue(b)) : 1, far = c => -Math.cos(hue(c) - hue(NIGHT_RGB));
      if (apart > 0.25 && apart < 0.98) return far(a) >= far(b) ? [a, b] : [b, a];   // 12 to 75 degrees apart: both
      return [a, turn(a)];                                // one colour (a small far-off accent doesn't count), its ring turned
    }

    /** The colour's hue turned 18 degrees toward magenta, about the grey axis: a one-colour light falls off the way a lamp
        does, amber into ember, blue into indigo, instead of into bronze or teal. */
    function turn(c) {
      const t = (Math.sin(-Math.PI / 3 - hue(c)) < 0 ? -18 : 18) * Math.PI / 180, cos = Math.cos(t), k = (1 - cos) / 3,
        s = Math.sqrt(1 / 3) * Math.sin(t), m = [cos + k, k - s, k + s];
      return [0, 1, 2].map(i => Math.max(0, Math.min(255, c[i] * m[0] + c[(i + 1) % 3] * m[1] + c[(i + 2) % 3] * m[2])));
    }

    function hue(c) {                                   // radians, from the RGB colour wheel
      return Math.atan2(Math.sqrt(3) * (c[1] - c[2]), 2 * c[0] - c[1] - c[2]);
    }

    function vivid(c) {
      const lo = Math.min(...c), hi = Math.max(...c);
      return c.map(v => 255 * (0.12 + 0.88 * (v - lo) / (hi - lo || 1)));
    }

    /** The light, opaque: the colour at the icon, darkening in its own hue across the room and into Night at the edge (a
        see-through light over navy would grey out, the way amber turns olive). Drawn brightest first, then dimmed step by
        step until no pixel passes its cap. Zoned (an app's light, on Apps only): a pixel's cap depends on where it lands
        across the screen, also when spread by the landing, with one cell of slack for the stretch's smoothing. */
    function draw(c, cols, zoned) {
      const x = c.getContext('2d');
      for (let s = VMAX; s > 0.05; s -= 0.04) {
        const g = x.createRadialGradient(24, 24, 0, 24, 24, 24);
        [[0, 1, 0], [0.3, 0.8, 0], [0.6, 0.58, 1], [0.85, 0.3, 1]].forEach(t => g.addColorStop(t[0], rgb(cols[t[2]], s * t[1])));
        g.addColorStop(1, NIGHT);
        x.fillStyle = NIGHT;
        x.fillRect(0, 0, 48, 48);
        x.fillStyle = g;
        x.fillRect(0, 0, 48, 48);
        const d = x.getImageData(0, 0, 48, 48).data;
        let ok = true;
        for (let i = 0; i < d.length && ok; i += 4) {
          const reach = ((i / 4 % 48 + 1.5) / 48 - 0.5) * W * SWELL;     // its right-hand reach from the centre, in vw
          ok = 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]) <= (zoned && CX + Math.max(reach, 0) < ZONE ? CAP_NAMES : CAP);
        }
        if (ok) { c.shade = `rgba(${cols[0].map(v => v * s * 0.3 | 0).join(',')}, .85)`; break; }
      }
      if (c === lit) html.style.setProperty('--shade', c.shade);
    }

    function canvas() {
      const c = document.createElement('canvas');
      c.className = 'light';
      c.width = c.height = 48;
      c.shade = LAMP_SHADE;
      room.append(c);
      return c;
    }

    function lightFor(img) {
      const src = img.src;
      if (lights[src]) return lights[src];
      const c = lights[src] = canvas(), pic = new Image();
      pic.crossOrigin = 'anonymous';                      // the store's Pages host sends CORS headers, so the pixels can be read
      pic.onload = () => { let cols = [FALLBACK, FALLBACK]; try { cols = accents(pic); } catch (e) { /* tainted after all */ } draw(c, cols, true); };
      pic.onerror = () => draw(c, [FALLBACK, FALLBACK], true);
      pic.src = src;
      return c;
    }

    /** The focused app's icon lights the room round it; on Tools, and on an app with a letter tile, the toolbox's own amber
        does. The fixed lamp is for About, the setup box and the bar above the list. On the tabs the room stays as it was. */
    function relight() {
      const f = document.querySelector('.focus');
      if (!f || f.closest('#dialog')) return;            // a question keeps the room as it was
      const page = document.querySelector('.page:not([hidden])');
      if (f.classList.contains('tab') && page && page.id !== 'about' && lit !== lamp) return;
      const row = f.closest('.row.app'), img = row && row.querySelector('img.icon'), spot = img || (row || f.closest('#tools')) && f;
      if (!amber && spot && !img) { amber = canvas(); const a = [255, 150, 40]; draw(amber, [a, turn(a)], false); }
      const next = img ? lightFor(img) : spot ? amber : lamp;
      if (spot) {
        const r = (f.closest('.row') || f).getBoundingClientRect();
        next.style.setProperty('--y', Math.round(r.top + r.height / 2) + 'px');
      }
      if (next === lit) return;
      lit.classList.remove('on', 'swell');
      next.classList.add('on');
      html.style.setProperty('--shade', next.shade);
      lit = next;
    }

    function land(r) {
      r.classList.add('landed');
      setTimeout(() => r.classList.remove('landed'), 1300);
      if (r.classList.contains('focus') || r.classList.contains('within')) {
        const l = lit;
        l.classList.add('swell');
        setTimeout(() => l.classList.remove('swell'), 1300);
      }
    }

    /** render() rebuilds every row, so rows are matched by data-key: busy then Open (or Installed) is an install that landed. */
    function landings() {
      const now = Date.now();
      document.querySelectorAll('#apps .row.app').forEach(r => {
        const k = r.dataset.key, word = r.querySelector('.act'), t = word ? word.textContent : '';
        if (r.classList.contains('busy')) busySince[k] = now;
        else if (busySince[k] && (t === 'Open' || t === 'Installed')) {
          if (now - busySince[k] < FRESH) land(r);
          delete busySince[k];
        } else if (t === 'Try again') delete busySince[k];
      });
    }

    /** A page's list was rebuilt: its focused row is new, so hold its grow still for a frame instead of replaying it. */
    function calm(records) {
      if (!records.some(m => m.type === 'childList' && m.target.classList && m.target.classList.contains('page'))) return;
      html.classList.add('calm');
      void document.body.offsetWidth;                     // computed now, with no transition
      requestAnimationFrame(() => html.classList.remove('calm'));
    }

    const update = records => { if (records) calm(records); relight(); landings(); };
    new MutationObserver(update).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    update();
  }

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
