#!/usr/bin/env node
// Renders profile.svg / profile-light.svg, one card pair per project, and README.md
// from profile.config.json plus live GitHub data.
//
// Text is converted to outlines with opentype.js: GitHub shows README SVGs as
// <img>, where web fonts do not load, so live text would fall back to a
// system face.
//
// Usage: GITHUB_TOKEN=... node .github/scripts/generate-profile.mjs
// The token needs read access to private repositories, otherwise languages
// and totals only cover public ones.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ASSETS = path.join(ROOT, '.github', 'assets');
const FONTS = path.join(ASSETS, 'fonts');

const W = 800;
const PAD = 28;
const INNER = W - PAD * 2;

const LANGUAGE_FALLBACK = {
  'C#': '#178600', TypeScript: '#3178c6', Python: '#3572A5', Go: '#00ADD8',
  JavaScript: '#f1e05a', HTML: '#e34c26', CSS: '#663399',
};

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function palette(mode) {
  if (mode === 'light') {
    return {
      mode,
      ground: '#efeaf8',
      border: 'rgba(81,43,212,0.32)',
      line: 'rgba(81,43,212,0.14)',
      text: '#1a1430',
      dim: '#4a4466',
      faint: '#7a7494',
      accent: '#5b35d1',
      cyan: '#0f766e',
      tile: 'rgba(81,43,212,0.06)',
      tileStroke: 'rgba(81,43,212,0.14)',
      glow: 0.42,
      heat: ['rgba(81,43,212,0.08)', '#cbbcf2', '#7c5ae0', '#512bd4', '#0e7490'],
      tones: {
        violet: { stroke: 'rgba(81,43,212,0.42)', fill: 'rgba(81,43,212,0.10)', text: '#3d278a' },
        cyan: { stroke: 'rgba(15,118,110,0.42)', fill: 'rgba(15,118,110,0.08)', text: '#0f4d48' },
        neutral: { stroke: 'rgba(26,20,48,0.16)', fill: 'rgba(26,20,48,0.04)', text: '#4a4466' },
      },
    };
  }
  return {
    mode,
    ground: '#07060d',
    border: 'rgba(124,92,255,0.30)',
    line: 'rgba(150,120,255,0.14)',
    text: '#f3f0ff',
    dim: '#aba6c7',
    faint: '#6f6a8c',
    accent: '#9b7fff',
    cyan: '#22d3ee',
    tile: 'rgba(155,127,255,0.06)',
    tileStroke: 'rgba(155,127,255,0.16)',
    glow: 1,
    heat: ['rgba(255,255,255,0.05)', '#35208a', '#6a45ea', '#22b4dc', '#d2f6ff'],
    tones: {
      violet: { stroke: 'rgba(155,127,255,0.55)', fill: 'rgba(81,43,212,0.18)', text: '#dcd2ff' },
      cyan: { stroke: 'rgba(34,211,238,0.45)', fill: 'rgba(34,211,238,0.07)', text: '#c6f3fb' },
      neutral: { stroke: 'rgba(255,255,255,0.18)', fill: 'rgba(255,255,255,0.03)', text: '#c9c5dd' },
    },
  };
}

async function loadFont(file) {
  const buf = await readFile(path.join(FONTS, file));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const F = {
  display: await loadFont('Unbounded-700.ttf'),
  body: await loadFont('Manrope-400.ttf'),
  bold: await loadFont('Manrope-600.ttf'),
  mono: await loadFont('JetBrainsMono-500.ttf'),
};

function measure(font, str, size, tracking = 0) {
  const glyphs = font.stringToGlyphs(str);
  const scale = size / font.unitsPerEm;
  const xs = [];
  let x = 0;
  glyphs.forEach((g, i) => {
    xs.push(x);
    x += (g.advanceWidth || 0) * scale;
    if (i < glyphs.length - 1) x += font.getKerningValue(g, glyphs[i + 1]) * scale + tracking;
  });
  return { glyphs, xs, width: x };
}

function text(font, str, { x, y, size, tracking = 0, anchor = 'start', fill, opacity, attrs = '' }) {
  const m = measure(font, str, size, tracking);
  const x0 = anchor === 'middle' ? x - m.width / 2 : anchor === 'end' ? x - m.width : x;
  const d = m.glyphs
    .map((g, i) => g.getPath(x0 + m.xs[i], y, size).toPathData(2))
    .filter(Boolean)
    .join('');
  const op = opacity == null ? '' : ` fill-opacity="${opacity}"`;
  return `<path d="${d}" fill="${fill}"${op}${attrs}/>`;
}

function wrap(font, str, size, maxWidth, maxLines) {
  const lines = [];
  let cur = '';
  for (const word of str.split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (!cur || measure(font, next, size).width <= maxWidth) cur = next;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (measure(font, `${last}…`, size).width > maxWidth && last.includes(' ')) {
    last = last.slice(0, last.lastIndexOf(' '));
  }
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

const ID_QUERY = `query ($login: String!) { user(login: $login) { id } }`;

const PROFILE_QUERY = `
query ($login: String!, $id: ID!) {
  user(login: $login) {
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
      totalCount
      nodes {
        name
        languages(first: 12, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
        defaultBranchRef {
          target { ... on Commit { history(author: { id: $id }) { totalCount } } }
        }
      }
    }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

async function gql(token, query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-generator' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

async function fetchStats(login, token) {
  const { id } = (await gql(token, ID_QUERY, { login })).user;
  const { user } = await gql(token, PROFILE_QUERY, { login, id });

  const bytes = new Map();
  const colors = new Map();
  for (const repo of user.repositories.nodes) {
    for (const { size, node } of repo.languages.edges) {
      bytes.set(node.name, (bytes.get(node.name) || 0) + size);
      if (node.color) colors.set(node.name, node.color);
    }
  }
  const total = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  const sorted = [...bytes.entries()].sort((a, b) => b[1] - a[1]);
  const languages = sorted.slice(0, 7).map(([name, size]) => ({
    name, share: size / total, color: LANGUAGE_FALLBACK[name] || colors.get(name) || '#8b86a8',
  }));
  const rest = sorted.slice(7).reduce((a, [, size]) => a + size, 0);
  if (rest > 0) languages.push({ name: 'Другие', share: rest / total, color: '#4a4666' });

  const commits = user.repositories.nodes
    .reduce((sum, repo) => sum + (repo.defaultBranchRef?.target?.history?.totalCount || 0), 0);

  const calendar = user.contributionsCollection.contributionCalendar;
  return {
    repos: user.repositories.totalCount,
    commits,
    languages,
    languageColors: Object.fromEntries(colors),
    contributions: calendar.totalContributions,
    weeks: calendar.weeks.map((w) => w.contributionDays),
  };
}

function glowDefs(C) {
  const a = C.glow;
  const radial = (id, color, alpha) =>
    `<radialGradient id="${id}" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${color}" stop-opacity="${(alpha * a).toFixed(2)}"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></radialGradient>`;
  return [
    radial('glow-violet', '#5b2fe0', 0.75),
    radial('glow-blue', '#2f64ff', 0.45),
    radial('glow-cyan', '#22d3ee', 0.4),
    radial('glow-magenta', '#b23ad8', 0.35),
    `<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="${C.mode === 'light' ? '#5b35d1' : '#ffffff'}" stroke-opacity="${C.mode === 'light' ? 0.06 : 0.035}"/></pattern>`,
    `<linearGradient id="scan" x1="0" x2="1"><stop offset="0" stop-color="${C.accent}" stop-opacity="0"/><stop offset="0.5" stop-color="${C.cyan}" stop-opacity="0.55"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></linearGradient>`,
    `<linearGradient id="name-fill" x1="180" x2="620" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${C.mode === 'light' ? '#2a1d66' : '#ffffff'}"/><stop offset="0.55" stop-color="${C.mode === 'light' ? '#5b35d1' : '#e6ddff'}"/><stop offset="1" stop-color="${C.mode === 'light' ? '#0f766e' : '#9fe9f7'}"/></linearGradient>`,
  ].join('');
}

const STYLE = `<style>
@keyframes drift-a { 0%, 100% { transform: translate(0px, 0px); } 50% { transform: translate(40px, -18px); } }
@keyframes drift-b { 0%, 100% { transform: translate(0px, 0px); } 50% { transform: translate(-36px, 16px); } }
@keyframes breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes scan { 0% { transform: translateX(-300px); } 100% { transform: translateX(1100px); } }
@keyframes twinkle { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.drift-a { animation: drift-a 9s ease-in-out infinite; }
.drift-b { animation: drift-b 11s ease-in-out infinite; }
.breathe { animation: breathe 6s ease-in-out infinite; }
.scan { animation: scan 7s linear infinite; }
.hot { animation: twinkle 3.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>`;

function sectionLabel(C, y, left, right) {
  return [
    `<line x1="${PAD}" x2="${W - PAD}" y1="${y}" y2="${y}" stroke="${C.line}"/>`,
    text(F.mono, left, { x: PAD, y: y + 28, size: 10.5, tracking: 3, fill: C.accent }),
    right ? text(F.mono, right, { x: W - PAD, y: y + 28, size: 10, tracking: 0.4, anchor: 'end', fill: C.faint }) : '',
  ].join('');
}

function placeOf(cfg) {
  return cfg.meta.split(' · ').slice(0, 2).join(' · ');
}

function renderProfile(cfg, stats, C) {
  const out = [];
  const place = placeOf(cfg);

  out.push(
    `<rect x="0" y="0" width="${W}" height="268" fill="url(#grid)"/>`,
    `<g class="drift-a"><ellipse cx="250" cy="86" rx="260" ry="150" fill="url(#glow-violet)"/></g>`,
    `<g class="drift-b"><ellipse cx="590" cy="186" rx="240" ry="130" fill="url(#glow-blue)"/></g>`,
    `<g class="breathe"><ellipse cx="660" cy="56" rx="150" ry="90" fill="url(#glow-cyan)"/></g>`,
    `<g class="breathe" style="animation-delay:2s"><ellipse cx="110" cy="226" rx="140" ry="80" fill="url(#glow-magenta)"/></g>`,
    `<g class="scan"><rect x="0" y="238" width="260" height="1.5" fill="url(#scan)"/></g>`,
  );

  out.push(text(F.mono, cfg.login, { x: PAD, y: 38, size: 11, tracking: 1.2, fill: C.faint }));
  out.push(text(F.mono, place, { x: W - PAD, y: 38, size: 11, tracking: 0.4, anchor: 'end', fill: C.faint }));
  out.push(`<line x1="${PAD}" x2="${W - PAD}" y1="48" y2="48" stroke="${C.line}"/>`);

  out.push(text(F.mono, cfg.eyebrow, { x: W / 2, y: 88, size: 11, tracking: 3.6, anchor: 'middle', fill: C.accent }));
  let nameSize = 38;
  const name = cfg.name.toUpperCase();
  while (measure(F.display, name, nameSize, 1.5).width > INNER - 40) nameSize -= 1;
  out.push(text(F.display, name, { x: W / 2, y: 142, size: nameSize, tracking: 1.5, anchor: 'middle', fill: 'url(#name-fill)' }));
  out.push(text(F.mono, cfg.tagline, { x: W / 2, y: 176, size: 10.5, tracking: 2.2, anchor: 'middle', fill: C.dim }));
  out.push(text(F.body, cfg.meta, { x: W / 2, y: 206, size: 13, anchor: 'middle', fill: C.faint }));

  let y = 250;

  const chipH = 26, gap = 8, chipPad = 12, chipSize = 11.5;
  const chips = cfg.chips.map((c) => ({ ...c, w: measure(F.mono, c.label, chipSize).width + chipPad * 2 }));
  const rows = [[]];
  let rowW = 0;
  for (const chip of chips) {
    const add = (rows.at(-1).length ? gap : 0) + chip.w;
    if (rowW + add > INNER && rows.at(-1).length) { rows.push([chip]); rowW = chip.w; }
    else { rows.at(-1).push(chip); rowW += add; }
  }
  for (const row of rows) {
    const width = row.reduce((a, c) => a + c.w, 0) + gap * (row.length - 1);
    let x = (W - width) / 2;
    for (const chip of row) {
      const tone = C.tones[chip.tone] || C.tones.neutral;
      out.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${chip.w.toFixed(1)}" height="${chipH}" rx="${chipH / 2}" fill="${tone.fill}" stroke="${tone.stroke}"/>`);
      out.push(text(F.mono, chip.label, { x: x + chip.w / 2, y: y + 17.5, size: chipSize, anchor: 'middle', fill: tone.text }));
      x += chip.w + gap;
    }
    y += chipH + gap;
  }
  y += 18;

  const stats4 = [
    { value: cfg.since, label: 'В ПРОДАКШЕНЕ С' },
    { value: num(stats.repos), label: plural(stats.repos, 'РЕПОЗИТОРИЙ', 'РЕПОЗИТОРИЯ', 'РЕПОЗИТОРИЕВ') },
    { value: num(stats.commits), label: plural(stats.commits, 'КОММИТ', 'КОММИТА', 'КОММИТОВ') },
    { value: cfg.tests, label: 'ТЕСТОВ В ПРОЕКТАХ' },
  ];
  const colGap = 10;
  const colW = (INNER - colGap * 3) / 4;
  stats4.forEach((s, i) => {
    const x = PAD + i * (colW + colGap);
    out.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${colW.toFixed(1)}" height="72" rx="12" fill="${C.tile}" stroke="${C.tileStroke}"/>`);
    const cx = x + colW / 2;
    out.push(text(F.display, s.value, { x: cx, y: y + 38, size: 26, anchor: 'middle', fill: C.text }));
    out.push(text(F.mono, s.label, { x: cx, y: y + 58, size: 8.5, tracking: 1.4, anchor: 'middle', fill: C.accent }));
  });
  y += 92;

  out.push(sectionLabel(C, y, 'СТЕК ПО КОДУ', 'доля байтов во всех репозиториях'));
  const barY = y + 46;
  out.push(`<rect x="${PAD}" y="${barY}" width="${INNER}" height="8" rx="4" fill="${C.tile}"/>`);
  out.push(`<clipPath id="bar-clip"><rect x="${PAD}" y="${barY}" width="${INNER}" height="8" rx="4"/></clipPath>`);
  let bx = PAD;
  const segs = [];
  stats.languages.forEach((l, i) => {
    const w = Math.max(3, l.share * INNER);
    const last = i === stats.languages.length - 1;
    const width = last ? PAD + INNER - bx : w - 2;
    segs.push(`<rect x="${bx.toFixed(1)}" y="${barY}" width="${Math.max(1, width).toFixed(1)}" height="8" fill="${l.color}"/>`);
    bx += w;
  });
  out.push(`<g clip-path="url(#bar-clip)">${segs.join('')}</g>`);
  const legendTop = barY + 32;
  const legendCol = INNER / 4;
  stats.languages.forEach((l, i) => {
    const lx = PAD + legendCol * (i % 4);
    const ly = legendTop + Math.floor(i / 4) * 22;
    out.push(`<circle cx="${lx + 4}" cy="${ly - 4}" r="4" fill="${l.color}"/>`);
    out.push(text(F.body, l.name, { x: lx + 14, y: ly, size: 12.5, fill: C.dim }));
    const nameW = measure(F.body, l.name, 12.5).width;
    const pct = l.share >= 0.1 ? `${Math.round(l.share * 100)}%` : `${(l.share * 100).toFixed(1).replace('.', ',')}%`;
    out.push(text(F.mono, pct, { x: lx + 22 + nameW, y: ly, size: 10.5, fill: C.faint }));
  });
  y = legendTop + Math.ceil(stats.languages.length / 4) * 22 + 10;

  out.push(sectionLabel(C, y, 'АКТИВНОСТЬ', `${num(stats.contributions)} ${plural(stats.contributions, 'вклад', 'вклада', 'вкладов')} за год`));
  const gridTop = y + 48;
  const weeks = stats.weeks;
  const step = INNER / weeks.length;
  const cell = Math.max(4, step - 3);
  const nonZero = weeks.flat().map((d) => d.contributionCount).filter((n) => n > 0).sort((a, b) => a - b);
  const q = (p) => nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.floor(p * nonZero.length))] : 1;
  const [t1, t2, t3] = [q(0.25), q(0.5), q(0.8)];
  const level = (n) => (n <= 0 ? 0 : n <= t1 ? 1 : n <= t2 ? 2 : n <= t3 ? 3 : 4);
  let hot = 0;
  let lastMonth = -1;
  weeks.forEach((days, wi) => {
    const x = PAD + wi * step;
    const month = new Date(`${days[0].date}T00:00:00Z`).getUTCMonth();
    if (month !== lastMonth && wi < weeks.length - 2) {
      if (lastMonth !== -1 || new Date(`${days[0].date}T00:00:00Z`).getUTCDate() <= 7) {
        out.push(text(F.mono, MONTHS[month], { x, y: gridTop + 7 * step + 14, size: 9.5, fill: C.faint }));
      }
      lastMonth = month;
    }
    days.forEach((d) => {
      const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
      const lv = level(d.contributionCount);
      const cls = lv === 4 ? ` class="hot" style="animation-delay:${((hot++ * 0.37) % 3.4).toFixed(2)}s"` : '';
      out.push(`<rect x="${x.toFixed(1)}" y="${(gridTop + dow * step).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="2.5" fill="${C.heat[lv]}"${cls}/>`);
    });
  });
  y = gridTop + 7 * step + 36;

  out.push(sectionLabel(C, y, 'ПРОЕКТЫ', 'витрины: архитектура и решения, код по запросу'));
  y += 28;

  const H = Math.round(y);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${STYLE}
<defs>${glowDefs(C)}<clipPath id="frame"><rect width="${W}" height="${H}" rx="20"/></clipPath></defs>
<g clip-path="url(#frame)">
<rect width="${W}" height="${H}" fill="${C.ground}"/>
${out.join('\n')}
</g>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="19.5" fill="none" stroke="${C.border}"/>
</svg>
`;
}

function renderCard(project, color, C) {
  const w = 390, h = 148;
  const chevronY = h - 22;
  const parts = [
    `<rect width="${w}" height="${h}" fill="${C.ground}"/>`,
    `<g class="drift-b"><ellipse cx="350" cy="10" rx="170" ry="110" fill="url(#glow-violet)" opacity="0.7"/></g>`,
    `<g class="breathe"><ellipse cx="40" cy="150" rx="140" ry="70" fill="url(#glow-blue)" opacity="0.5"/></g>`,
    `<rect x="0" y="0" width="3" height="${h}" fill="${color}"/>`,
    text(F.bold, project.title, { x: 22, y: 40, size: 16.5, fill: C.text }),
  ];
  wrap(F.body, project.description, 12.5, w - 56, 2).forEach((line, i) => {
    parts.push(text(F.body, line, { x: 22, y: 66 + i * 18, size: 12.5, fill: C.dim }));
  });
  parts.push(
    `<line x1="22" x2="${w - 22}" y1="${h - 40}" y2="${h - 40}" stroke="${C.line}"/>`,
    `<circle cx="26" cy="${chevronY}" r="4" fill="${color}"/>`,
    text(F.mono, project.language, { x: 36, y: chevronY + 4, size: 11, fill: C.dim }),
    text(F.mono, project.metric, { x: w - 36, y: chevronY + 4, size: 11, anchor: 'end', fill: C.accent }),
    `<path d="M${w - 26} ${chevronY - 5}l6 5-6 5" fill="none" stroke="${C.accent}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
${STYLE}
<defs>${glowDefs(C)}<clipPath id="frame"><rect width="${w}" height="${h}" rx="14"/></clipPath></defs>
<g clip-path="url(#frame)">
${parts.join('\n')}
</g>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="13.5" fill="none" stroke="${C.border}"/>
</svg>
`;
}

function picture(darkSrc, lightSrc, alt, width) {
  return `<picture>
  <source media="(prefers-color-scheme: light)" srcset="${lightSrc}">
  <img src="${darkSrc}" alt="${alt}" width="${width}">
</picture>`;
}

function renderReadme(cfg, projects) {
  const rows = [];
  for (let i = 0; i < projects.length; i += 2) {
    const cell = (p) => {
      if (!p) return '<td width="50%"></td>';
      return `<td width="50%" valign="top">
<a href="https://github.com/${cfg.login}/${p.repo}">${picture(
        `./.github/assets/card-${p.repo}.svg`,
        `./.github/assets/card-${p.repo}-light.svg`,
        `${p.title}: ${p.description}`,
        '100%',
      )}</a>
</td>`;
    };
    rows.push(`<tr>${cell(projects[i])}${cell(projects[i + 1])}</tr>`);
  }
  return `<div align="center">

${picture(
    './.github/assets/profile.svg',
    './.github/assets/profile-light.svg',
    `${cfg.name}: ${cfg.eyebrow.toLowerCase()}`,
    '100%',
  )}

<table width="100%">
${rows.join('\n')}
</table>

</div>

<!-- Сгенерировано .github/scripts/generate-profile.mjs из profile.config.json. Правки вносить туда. -->
`;
}

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is not set');
  process.exit(1);
}

const cfg = JSON.parse(await readFile(path.join(ROOT, 'profile.config.json'), 'utf8'));
const stats = await fetchStats(cfg.login, token);
console.log(`repos=${stats.repos} commits=${stats.commits} contributions=${stats.contributions}`);
console.log(stats.languages.map((l) => `${l.name} ${(l.share * 100).toFixed(1)}%`).join(', '));

await mkdir(ASSETS, { recursive: true });

const visible = cfg.projects.filter((p) => !p.hidden);
const dark = palette('dark');
const light = palette('light');

await writeFile(path.join(ASSETS, 'profile.svg'), renderProfile(cfg, stats, dark));
await writeFile(path.join(ASSETS, 'profile-light.svg'), renderProfile(cfg, stats, light));

for (const p of visible) {
  const color = stats.languageColors[p.language] || LANGUAGE_FALLBACK[p.language] || dark.accent;
  await writeFile(path.join(ASSETS, `card-${p.repo}.svg`), renderCard(p, color, dark));
  await writeFile(path.join(ASSETS, `card-${p.repo}-light.svg`), renderCard(p, color, light));
}
await writeFile(path.join(ROOT, 'README.md'), renderReadme(cfg, visible));
console.log(`wrote profile.svg + light, ${visible.length} card pairs, README.md`);
