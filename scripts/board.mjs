#!/usr/bin/env node
// Fire Enrich Board — renders the beads backlog as one HTML page for the
// published artifact. Data: `bd list --all --json` + `gh pr list --json`.
// Usage: node scripts/board.mjs [--note "what happened at this check-in"]
// Output: board/index.html (board/ is git-excluded). Republish the same
// artifact URL after every check-in.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = resolve(ROOT, 'board');
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const noteIdx = args.indexOf('--note');
const note = noteIdx !== -1 ? args[noteIdx + 1] : null;

function sh(cmd, fallback) {
  try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return fallback; }
}

const issues = JSON.parse(sh('bd list --all -n 0 --json', '[]'));
// gh resolves a fork to its parent by default; pin the fork explicitly.
const originUrl = sh('git remote get-url origin', '').trim();
const ownerRepo = originUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1] || '';
const prs = JSON.parse(sh(`gh pr list ${ownerRepo ? `--repo ${ownerRepo}` : ''} --state all --limit 100 --json number,title,headRefName,url,state,body,isDraft`, '[]'));
// Normalise dependency entries: `bd list --json` gives {issue_id, depends_on_id, type};
// resolve each to the blocking issue so status is available.
const idIndex = new Map(issues.map(i => [i.id, i]));
for (const i of issues) {
  i.blockers = (i.dependencies || [])
    .map(d => idIndex.get(d.depends_on_id ?? d.id))
    .filter(Boolean);
}
writeFileSync(resolve(OUT, 'issues.json'), JSON.stringify(issues, null, 2));
writeFileSync(resolve(OUT, 'prs.json'), JSON.stringify(prs, null, 2));

// ---- log --------------------------------------------------------------
const logPath = resolve(OUT, 'log.json');
const log = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : [];
if (note) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  log.unshift({ at: stamp, note });
  writeFileSync(logPath, JSON.stringify(log, null, 2));
}

// ---- derive -----------------------------------------------------------
const byId = new Map(issues.map(i => [i.id, i]));
const prFor = (id) => prs.find(p => p.headRefName?.includes(id) || p.title?.includes(id) || p.body?.includes(id));
const milestoneOf = (i) => (i.labels || []).find(l => l.startsWith('milestone:'))?.slice(10).replace(/_/g, ' ') || 'Unassigned';
const MILESTONES = ['MVP', 'Quality and Deploy', 'v1.1', 'v2'];
const PRIO = ['P0', 'P1', 'P2', 'P3', 'P4'];

function laneOf(i) {
  if (i.status === 'closed') return 'done';
  const pr = prFor(i.id);
  if (pr && pr.state === 'OPEN') return 'review';
  if (i.status === 'in_progress') return 'progress';
  const blockers = i.blockers.filter(d => d.status !== 'closed');
  return blockers.length ? 'queued' : 'ready';
}
const LANES = [
  ['queued', 'Queued', 'waiting on a dependency'],
  ['ready', 'Ready', 'no blockers, unclaimed'],
  ['progress', 'In progress', 'claimed, branch open'],
  ['review', 'In review', 'PR open'],
  ['done', 'Done', 'closed'],
];

const counts = Object.fromEntries(LANES.map(([k]) => [k, 0]));
const lanes = new Map(issues.map(i => { const l = laneOf(i); counts[l]++; return [i.id, l]; }));

// Topological levels for the order diagram (Kahn), by dependency depth.
const level = new Map();
function depth(i, seen = new Set()) {
  if (level.has(i.id)) return level.get(i.id);
  if (seen.has(i.id)) return 0;
  seen.add(i.id);
  const deps = i.blockers;
  const d = deps.length ? 1 + Math.max(...deps.map(x => depth(x, seen))) : 0;
  level.set(i.id, d);
  return d;
}
issues.forEach(i => depth(i));

// ---- html helpers -----------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (s, n = 110) => s.length > n ? s.slice(0, n - 1) + '…' : s;

function card(i) {
  const pr = prFor(i.id);
  const blockers = i.blockers.filter(d => d.status !== 'closed');
  return `<article class="card lane-${lanes.get(i.id)}">
    <header><span class="prio ${PRIO[i.priority] || 'P4'}">${PRIO[i.priority] || 'P4'}</span><code class="id">${esc(i.id)}</code>${i.owner && i.status === 'in_progress' ? `<span class="owner">claimed</span>` : ''}</header>
    <h4>${esc(i.title)}</h4>
    <p>${esc(short(i.description || ''))}</p>
    <footer>${blockers.length ? `<span class="meta">blocked by ${blockers.map(b => `<code>${esc(b.id)}</code>`).join(' ')}</span>` : ''}${pr ? `<a class="pr" href="${esc(pr.url)}">PR #${pr.number}${pr.state === 'MERGED' ? ' merged' : pr.state === 'CLOSED' ? ' closed' : ''}</a>` : ''}</footer>
  </article>`;
}

function milestoneSection(ms) {
  const items = issues.filter(i => milestoneOf(i) === ms);
  if (!items.length) return '';
  const done = items.filter(i => lanes.get(i.id) === 'done').length;
  const cols = LANES.map(([k, label]) => {
    const inLane = items.filter(i => lanes.get(i.id) === k).sort((a, b) => (a.priority - b.priority) || (level.get(a.id) - level.get(b.id)));
    return `<div class="col"><div class="colhead"><span>${label}</span><span class="n">${inLane.length}</span></div>${inLane.map(card).join('') || '<div class="empty">none</div>'}</div>`;
  }).join('');
  return `<section class="ms" id="ms-${ms.toLowerCase().replace(/[^a-z0-9]+/g, '-')}">
    <div class="mshead"><h3>${esc(ms)}</h3><span class="progress"><span style="width:${items.length ? Math.round(done / items.length * 100) : 0}%"></span></span><span class="n">${done} / ${items.length} done</span></div>
    <div class="board">${cols}</div>
  </section>`;
}

// Order diagram: layered SVG, levels left→right, one row per issue in a level.
function orderSvg() {
  const maxL = Math.max(0, ...level.values());
  const perLevel = new Map();
  issues.forEach(i => { const l = level.get(i.id); if (!perLevel.has(l)) perLevel.set(l, []); perLevel.get(l).push(i); });
  const W = 250, H = 52, GX = 70, GY = 14, PAD = 20;
  const pos = new Map();
  let maxRows = 0;
  for (let l = 0; l <= maxL; l++) {
    const rows = (perLevel.get(l) || []).sort((a, b) => a.priority - b.priority);
    maxRows = Math.max(maxRows, rows.length);
    rows.forEach((i, r) => pos.set(i.id, { x: PAD + l * (W + GX), y: PAD + r * (H + GY) }));
  }
  const width = PAD * 2 + (maxL + 1) * W + maxL * GX;
  const height = PAD * 2 + maxRows * H + (maxRows - 1) * GY;
  const edges = [];
  for (const i of issues) for (const d of i.blockers) {
    const a = pos.get(d.id), b = pos.get(i.id);
    if (!a || !b) continue;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const c = (x2 - x1) / 2;
    edges.push(`<path d="M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}" class="edge ${d.status === 'closed' ? 'edge-done' : ''}"/>`);
  }
  const nodes = issues.map(i => {
    const p = pos.get(i.id);
    return `<g class="node lane-${lanes.get(i.id)}" transform="translate(${p.x},${p.y})">
      <rect width="${W}" height="${H}" rx="6"/>
      <text x="12" y="20" class="nid">${esc(i.id)} · ${PRIO[i.priority] || ''}</text>
      <text x="12" y="39" class="ntitle">${esc(short(i.title, 34))}</text>
    </g>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Build order: dependencies flow left to right">${edges.join('')}${nodes}</svg>`;
}

const generated = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const repo = sh('git remote get-url origin', '').trim().replace(/\.git$/, '');
const branch = sh('git branch --show-current', '').trim();

const html = `<title>Fire Enrich Board</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<style>
:root{
  --heat:#fa5d19; --heat-soft:#fde8dd; --ink:#262626; --ink-2:#5c534d; --ink-3:#8a7f77;
  --ground:#faf7f4; --panel:#f3eee9; --panel-2:#ebe4dd; --line:#e2d9d1; --card:#ffffff;
  --ok:#2e8b57; --ok-soft:#e3f2ea; --review:#2a6dfb; --review-soft:#e4ecfd; --progress:#b7791f; --progress-soft:#f8efd8; --queued:#a39a92;
  --font:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif; --mono:"Geist Mono",ui-monospace,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --heat:#ff7a3d; --heat-soft:#3a2418; --ink:#efe9e3; --ink-2:#b9aea5; --ink-3:#877b72;
  --ground:#171412; --panel:#1f1b18; --panel-2:#27221e; --line:#332c27; --card:#211d1a;
  --ok:#5fc48c; --ok-soft:#1c2e24; --review:#7aa2ff; --review-soft:#1c2540; --progress:#e0a844; --progress-soft:#332a18; --queued:#6e655e;
}}
:root[data-theme="dark"]{
  --heat:#ff7a3d; --heat-soft:#3a2418; --ink:#efe9e3; --ink-2:#b9aea5; --ink-3:#877b72;
  --ground:#171412; --panel:#1f1b18; --panel-2:#27221e; --line:#332c27; --card:#211d1a;
  --ok:#5fc48c; --ok-soft:#1c2e24; --review:#7aa2ff; --review-soft:#1c2540; --progress:#e0a844; --progress-soft:#332a18; --queued:#6e655e;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--font);font-size:14px;line-height:1.5;padding-inline:16px}
a{color:var(--review)} a:focus-visible,button:focus-visible{outline:2px solid var(--heat);outline-offset:2px}
h1,h2,h3,h4{margin:0;text-wrap:balance}
.shell{display:grid;grid-template-columns:288px minmax(0,1fr);min-height:100vh;margin-inline:-16px}
.idx{position:sticky;top:0;height:100vh;overflow-y:auto;border-right:1px solid var(--line);background:var(--panel);padding:30px 22px 40px}
.idx h1{font-size:18px;font-weight:700;letter-spacing:-.01em}
.idx .sub{color:var(--ink-3);font-size:12px;margin:4px 0 22px}
.idx ol{list-style:none;padding:0;margin:0;display:grid;gap:2px}
.idx li a{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:8px 10px;border-radius:6px;color:var(--ink);text-decoration:none}
.idx li a:hover{background:var(--panel-2)}
.idx li a .k{font-family:var(--mono);font-size:11px;color:var(--ink-3)}
.idx .stat{margin-top:26px;padding-top:18px;border-top:1px solid var(--line);display:grid;gap:8px;font-size:12px;color:var(--ink-2)}
.idx .stat b{font-family:var(--mono);font-weight:500;color:var(--ink);font-variant-numeric:tabular-nums}
main{padding:44px 44px 120px;max-width:1400px;min-width:0}
.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin-bottom:6px}
.summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:22px 0 40px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.tile .n{font-family:var(--mono);font-size:26px;font-weight:500;font-variant-numeric:tabular-nums;line-height:1.1}
.tile .l{font-size:12px;color:var(--ink-2);margin-top:4px}
.tile .h{font-size:11px;color:var(--ink-3)}
.tile.ready{border-color:var(--heat);background:var(--heat-soft)} .tile.ready .n{color:var(--heat)}
section.part{margin-top:56px}
section.part>h2{font-size:22px;font-weight:700;letter-spacing:-.01em;margin-bottom:6px}
section.part>.lead{color:var(--ink-2);max-width:62ch;margin:0 0 22px}
.ms{margin-top:30px}
.mshead{display:flex;align-items:center;gap:14px;margin-bottom:12px}
.mshead h3{font-size:15px;font-weight:600}
.mshead .n{font-family:var(--mono);font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums}
.progress{flex:1;max-width:220px;height:6px;background:var(--panel-2);border-radius:3px;overflow:hidden}
.progress span{display:block;height:100%;background:var(--ok)}
.board{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;align-items:start}
.colhead{display:flex;justify-content:space-between;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding:0 4px 8px;border-bottom:1px solid var(--line);margin-bottom:8px}
.colhead .n{font-family:var(--mono);font-variant-numeric:tabular-nums}
.col{display:grid;gap:8px;min-width:0}
.empty{color:var(--ink-3);font-size:12px;padding:6px 4px}
.card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--queued);border-radius:6px;padding:10px 12px 10px 11px;min-width:0}
.card.lane-ready{border-left-color:var(--heat)} .card.lane-progress{border-left-color:var(--progress)} .card.lane-review{border-left-color:var(--review)} .card.lane-done{border-left-color:var(--ok);opacity:.85}
.card header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.card h4{font-size:13px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}
.card p{margin:6px 0 0;font-size:12px;color:var(--ink-2);line-height:1.45;overflow-wrap:anywhere}
.card footer{display:flex;flex-wrap:wrap;gap:8px 12px;margin-top:8px;font-size:11px;color:var(--ink-3)}
.card footer code,.id{font-family:var(--mono);font-size:11px}
.id{color:var(--ink-2)}
.owner{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--progress)}
.prio{font-family:var(--mono);font-size:10px;font-weight:500;padding:1px 6px;border-radius:4px;background:var(--panel-2);color:var(--ink-2)}
.prio.P0{background:var(--heat-soft);color:var(--heat)}
.pr{font-size:11px;font-weight:500;text-decoration:none;padding:1px 6px;border-radius:4px;background:var(--review-soft);color:var(--review)}
.order{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px}
.order svg{display:block;max-width:none}
.order .edge{fill:none;stroke:var(--ink-3);stroke-width:1.2;opacity:.55}
.order .edge-done{stroke:var(--ok)}
.order .node rect{fill:var(--card);stroke:var(--line)}
.order .node.lane-ready rect{stroke:var(--heat);stroke-width:1.6}
.order .node.lane-done rect{stroke:var(--ok)}
.order .node.lane-review rect{stroke:var(--review)}
.order .node.lane-progress rect{stroke:var(--progress)}
.order .nid{font-family:var(--mono);font-size:10px;fill:var(--ink-3)}
.order .ntitle{font-family:var(--font);font-size:12px;font-weight:500;fill:var(--ink)}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin:12px 0 0;font-size:12px;color:var(--ink-2)}
.legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px;background:var(--queued)}
.legend .r::before{background:var(--heat)} .legend .p::before{background:var(--progress)} .legend .v::before{background:var(--review)} .legend .d::before{background:var(--ok)}
.log{list-style:none;padding:0;margin:0;display:grid;gap:0;border-top:1px solid var(--line)}
.log li{display:grid;grid-template-columns:130px minmax(0,1fr);gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}
.log time{font-family:var(--mono);font-size:12px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.foot{margin-top:60px;color:var(--ink-3);font-size:12px}
@media (max-width:1100px){.board,.summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:900px){.shell{grid-template-columns:1fr}.idx{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:28px 16px 80px}}
@media (max-width:560px){.board,.summary{grid-template-columns:1fr}.log li{grid-template-columns:1fr;gap:2px}}
@media (prefers-reduced-motion: reduce){*{transition:none!important}}
</style>
<div class="shell">
  <nav class="idx" aria-label="Sections">
    <h1>Fire Enrich Board</h1>
    <div class="sub">hamchowderr/fire-enrich · <code>${esc(branch)}</code></div>
    <ol>
      <li><a href="#status"><span>1 · Status</span><span class="k">${issues.length}</span></a></li>
      <li><a href="#board"><span>2 · Board</span><span class="k">${MILESTONES.filter(m => issues.some(i => milestoneOf(i) === m)).length} milestones</span></a></li>
      <li><a href="#order"><span>3 · Build order</span><span class="k">${issues.reduce((n, i) => n + i.blockers.length, 0)} links</span></a></li>
      <li><a href="#log"><span>4 · Check-ins</span><span class="k">${log.length}</span></a></li>
    </ol>
    <div class="stat">
      <div>Ready now <b>${counts.ready}</b></div>
      <div>In progress <b>${counts.progress}</b></div>
      <div>In review <b>${counts.review}</b></div>
      <div>Done <b>${counts.done}</b> of <b>${issues.length}</b></div>
      <div>Generated <b>${generated}</b></div>
    </div>
  </nav>
  <main>
    <section id="status" class="part" style="margin-top:0">
      <div class="eyebrow">Beads · prefix fe · embedded store</div>
      <h2>Where the build stands</h2>
      <p class="lead">One card per beads issue, seeded from the Fire Enrich PRD. A card moves right as it is claimed, opened as a pull request into <code>develop</code>, and closed. Regenerated from <code>bd</code> and <code>gh</code> at every check-in.</p>
      <div class="summary">
        ${LANES.map(([k, label, hint]) => `<div class="tile ${k}"><div class="n">${counts[k]}</div><div class="l">${label}</div><div class="h">${hint}</div></div>`).join('')}
      </div>
    </section>
    <section id="board" class="part">
      <h2>Board</h2>
      <p class="lead">Grouped by milestone in delivery order. Priority P0 is critical; queued cards wait on the issues named in their footer.</p>
      ${MILESTONES.map(milestoneSection).join('')}
    </section>
    <section id="order" class="part">
      <h2>Build order</h2>
      <p class="lead">Dependencies flow left to right. An issue becomes ready when every box pointing into it is done. Scroll sideways for the later levels.</p>
      <div class="order">${orderSvg()}</div>
      <div class="legend"><span class="r">ready</span><span class="p">in progress</span><span class="v">in review</span><span class="d">done</span><span>queued</span></div>
    </section>
    <section id="log" class="part">
      <h2>Check-ins</h2>
      <p class="lead">One line per check-in: what closed, what opened, what changed in the plan.</p>
      <ul class="log">${log.length ? log.map(e => `<li><time>${esc(e.at)}</time><div>${esc(e.note)}</div></li>`).join('') : '<li><time>—</time><div>No check-ins logged yet.</div></li>'}</ul>
    </section>
    <p class="foot">Repository ${esc(repo)} · Plan and PRD live in the vault (Fire Enrich). Board generated by <code>scripts/board.mjs</code>.</p>
  </main>
</div>
`;
writeFileSync(resolve(OUT, 'index.html'), html);
console.log(`board/index.html written: ${issues.length} issues, ${prs.length} PRs, ${log.length} log entries; lanes ${JSON.stringify(counts)}`);
