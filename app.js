import { createGame, rollDice, roll, applyMove, getLegalMoves, botPick, isOver, trackIndex, SAFE, blockades, movePath } from './engine.js';

const NS = 'http://www.w3.org/2000/svg';
const COL = { red: '#e8483f', green: '#2fa35b', yellow: '#f2b822', blue: '#2f7de1' };
const run = (x, y, dx, dy, n) => Array.from({ length: n }, (_, k) => [x + dx * k, y + dy * k]);
const TRACK = [...run(1,6,1,0,5), ...run(6,5,0,-1,6), ...run(7,0,1,0,2), ...run(8,1,0,1,5), ...run(9,6,1,0,6), ...run(14,7,0,1,2),
  ...run(13,8,-1,0,5), ...run(8,9,0,1,6), ...run(7,14,-1,0,2), ...run(6,13,0,-1,5), ...run(5,8,-1,0,6), ...run(0,7,0,-1,2)];
const HOME = { red: run(1,7,1,0,5), green: run(7,1,0,1,5), yellow: run(13,7,-1,0,5), blue: run(7,13,0,-1,5) };
const ORIGIN = { red: [0,0], green: [9,0], yellow: [9,9], blue: [0,9] };
const SLOTS = [[1.5,1.5],[3.5,1.5],[1.5,3.5],[3.5,3.5]];
const FIN = [[-.3,-.3],[.3,-.3],[-.3,.3],[.3,.3]];

const $ = (id) => document.getElementById(id);
const el = (t, a, p) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); p && p.appendChild(e); return e; };
const svg = $('board'), tokEls = {}, baseEl = {};
const cap = (c) => c[0].toUpperCase() + c.slice(1);
let cfg, me = null, viewColor = null, rotNow = 0, root;
const ROT = { blue: 0, yellow: 90, green: 180, red: 270 };   // degrees to bring a colour to the bottom-left
const UNR = { red: [-1, -1], green: [1, -1], yellow: [1, 1], blue: [-1, 1] };
const ORDER = ['red', 'green', 'yellow', 'blue'], OPP = { red: 'yellow', yellow: 'red', green: 'blue', blue: 'green' };
function setView(c) {                       // turn the board the shortest way, smoothly
  if (c === viewColor) return;
  viewColor = c; rotNow += ((ROT[c] - rotNow) % 360 + 540) % 360 - 180;
  root.style.transform = `rotate(${rotNow}deg)`;
}
let S, bots = new Set(), note = '';

function buildBoard() {
  svg.innerHTML = '';
  root = el('g', { class: 'root' }, svg);
  viewColor = me ?? 'blue'; rotNow = ROT[viewColor]; root.style.transform = `rotate(${rotNow}deg)`;
  for (const c in ORIGIN) {
    const [x, y] = ORIGIN[c];
    baseEl[c] = el('rect', { x, y, width: 6, height: 6, rx: .6, fill: COL[c] }, root);
    el('rect', { x: x + 1, y: y + 1, width: 4, height: 4, rx: .5, fill: '#fff' }, root);
  }
  TRACK.forEach(([x, y], i) => {
    const start = Object.entries({ red: 0, green: 13, yellow: 26, blue: 39 }).find(([, v]) => v === i);
    el('rect', { x, y, width: 1, height: 1, fill: start ? COL[start[0]] : '#fff', stroke: '#c9ced6', 'stroke-width': .04 }, root);
    if (SAFE.includes(i) && !start) el('text', { x: x + .5, y: y + .72, 'text-anchor': 'middle', 'font-size': .7, fill: '#9aa3b2' }, root).textContent = '★';
  });
  for (const c in HOME) HOME[c].forEach(([x, y]) => el('rect', { x, y, width: 1, height: 1, fill: COL[c], opacity: .85, stroke: '#fff', 'stroke-width': .04 }, root));
  [['red','6,6 6,9 7.5,7.5'],['green','6,6 9,6 7.5,7.5'],['yellow','9,6 9,9 7.5,7.5'],['blue','6,9 9,9 7.5,7.5']]
    .forEach(([c, pts]) => el('polygon', { points: pts, fill: COL[c] }, root));
  for (const c of S.colors) for (let i = 0; i < 4; i++) {
    const g = el('g', { class: 'tok' }, root);
    el('circle', { r: .38, fill: COL[c], stroke: '#fff', 'stroke-width': .09 }, g);
    el('circle', { r: .14, fill: '#fff', opacity: .55 }, g);
    g.addEventListener('click', () => onToken(c, i));
    tokEls[c + i] = g;
  }
}

function pos(c, p, i) {
  if (p === -1) { const [ox, oy] = ORIGIN[c], [sx, sy] = SLOTS[i]; return [ox + sx, oy + sy]; }
  if (p <= 51) { const [x, y] = TRACK[trackIndex(c, p)]; return [x + .5, y + .5]; }
  if (p <= 104) { const [x, y] = HOME[c][p - 100]; return [x + .5, y + .5]; }
  return [7.5 + FIN[i][0], 7.5 + FIN[i][1]];
}

function draw() {
  const cur = S.colors[S.turn], legal = !busy && S.dice != null ? getLegalMoves(S, S.dice) : [];
  if (me) setView(me);   // online/bot games: your colour in front. Shared-screen games: no rotation
  const P = {}, cnt = {}, used = {};
  const bl = new Set(blockades(S).flatMap((b) => b.ids.map((i) => b.color + i)));
  for (const c of S.colors) S.tokens[c].forEach((p, i) => {
    const e = ovr[c + i] ?? p; P[c + i] = pos(c, e, i);
    if (e >= 0 && e <= 104) cnt[P[c + i]] = (cnt[P[c + i]] || 0) + 1;
  });
  for (const c of S.colors) S.tokens[c].forEach((p, i) => {
    const [x0, y0] = P[c + i], k = String(P[c + i]), g = tokEls[c + i];
    const n = cnt[k] > 1 ? (used[k] = (used[k] ?? -1) + 1) : 0;
    const o = cnt[k] > 1 ? (n - (cnt[k] - 1) / 2) * .26 : 0;
    g.style.setProperty('--x', `${x0 + o}px`); g.style.setProperty('--y', `${y0 + o}px`);
    g.style.transform = `translate(${x0 + o}px, ${y0 + o}px)`;
    g.classList.toggle('blk', bl.has(c + i));
    g.classList.toggle('can', c === cur && !bots.has(c) && legal.includes(i));
  });
  const human = !bots.has(cur) && !isOver(S);
  $('chips').innerHTML = S.colors.map((c) => `<span class="chip${c === cur && !isOver(S) ? ' on' : ''}" style="--c:${COL[c]}"><i></i>${cap(c)}${bots.has(c) ? ' 🤖' : ''}<small>${S.captured[c] ? '🔓' : '🔒'} ${S.tokens[c].filter((q) => q === 105).length}/4</small></span>`).join('');
  for (const c in baseEl) baseEl[c].style.opacity = !isOver(S) && c !== cur ? .5 : 1;
  $('result').hidden = !isOver(S);
  if (isOver(S)) { $('rtitle').textContent = `${cap(S.winners[0])} wins!`; $('rorder').textContent = 'Finishing order: ' + S.winners.map(cap).join(' → '); }
  $('roll').disabled = !(human && S.dice == null && !busy);
  $('roll').style.setProperty('--c', COL[cur]);
  $('status').textContent = isOver(S)
    ? 'Game over'
    : note || (human ? (S.dice == null ? `${cap(cur)}: tap the dice` : `${cap(cur)}: tap a glowing piece`) : `${cap(cur)} is thinking…`);
  note = '';
}

const PIPS = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
const pipsHTML = (n) => Array.from({ length: 9 }, (_, k) => `<b${PIPS[n].includes(k) ? ' class="on"' : ''}></b>`).join('');
function setDie(n) {
  const d = $('die');
  d.innerHTML = n ? pipsHTML(n) : '<em>ROLL</em>';
  d.classList.remove('shake'); void d.offsetWidth; if (n) d.classList.add('shake');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false, gid = 0;
const ovr = {}; // temporary per-token position while it hops

function step() {
  draw();
  if (isOver(S)) return;
  if (bots.has(S.colors[S.turn])) setTimeout(() => (S.dice == null ? doRoll() : doMove(botPick(S, S.dice))), 650);
}
// A 3D cube is thrown from the roller's corner and rolls (end over end) to the middle of the board
const FACE = { 1: 'rotateX(0deg)', 2: 'rotateY(-90deg)', 3: 'rotateX(-90deg)', 4: 'rotateX(90deg)', 5: 'rotateY(90deg)', 6: 'rotateY(180deg)' };
async function tumble(d, color) {
  const big = $('bigdie'), k = $('board').clientWidth * .3;
  const th = (ROT[viewColor] * Math.PI) / 180, [ux, uy] = UNR[color];
  const kx = Math.round(ux * Math.cos(th) - uy * Math.sin(th)), ky = Math.round(ux * Math.sin(th) + uy * Math.cos(th));
  big.style.setProperty('--pip', COL[color]);
  big.innerHTML = '<div class="cube">' + [1, 2, 3, 4, 5, 6].map((n) => `<div class="face f${n}">${pipsHTML(n)}</div>`).join('') + '</div>';
  big.hidden = false;
  const at = (t, z, deg) => `perspective(700px) translate3d(${kx * k * (1 - t)}px, ${ky * k * (1 - t)}px, ${z}px) rotate3d(${ky}, ${-kx}, 0, ${deg}deg) ${FACE[d]}`;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const flight = big.firstChild.animate([
    { transform: at(0, 0, 0), offset: 0, easing: 'ease-out' },
    { transform: at(.42, 110, 260), offset: .28, easing: 'ease-in' },   // thrown up
    { transform: at(.55, 0, 360), offset: .45, easing: 'ease-out' },    // lands, rolls on
    { transform: at(.85, 55, 560), offset: .65, easing: 'ease-in' },
    { transform: at(.95, 0, 680), offset: .8, easing: 'ease-out' },
    { transform: at(1, 0, 720), offset: 1 },
  ], { duration: reduce ? 1 : 1000, easing: 'linear', fill: 'forwards' });
  await flight.finished; await sleep(550); big.hidden = true;
}
async function doRoll() {
  if (S.dice != null || busy) return;
  const g0 = gid; busy = true; draw();
  const d = rollDice(); await tumble(d, S.colors[S.turn]);
  if (g0 !== gid) return;
  busy = false; setDie(d);
  const who = S.colors[S.turn], n = roll(S, d);
  if (n.dice == null) { note = `${cap(who)} rolled ${d}: no move`; S = n; draw(); setTimeout(step, 900); }
  else { S = n; step(); }
}
// Pieces hop square by square along the exact path
async function doMove(i) {
  if (busy) return;
  const g0 = gid; busy = true; draw();
  const c = S.colors[S.turn], d = S.dice, next = applyMove(S, i, d), path = movePath(S, i, d);
  const movers = S.tokens[c].map((_, j) => j).filter((j) => next.tokens[c][j] !== S.tokens[c][j]);
  for (const q of path) {
    movers.forEach((j) => { ovr[c + j] = q; });
    draw();
    movers.forEach((j) => { const g = tokEls[c + j]; g.classList.remove('hop'); void g.getBoundingClientRect(); g.classList.add('hop'); });
    await sleep(220);
    if (g0 !== gid) return;
  }
  movers.forEach((j) => delete ovr[c + j]);
  busy = false; S = next; step();
}
function onToken(c, i) {
  if (busy || c !== S.colors[S.turn] || bots.has(c) || S.dice == null || isOver(S)) return;
  if (getLegalMoves(S, S.dice).includes(i)) doMove(i);
}

function start(colors, botColors, who = null) {
  gid++; busy = false; $('bigdie').hidden = true; S = createGame(colors); bots = new Set(botColors);
  setDie(0); cfg = [colors, botColors, who]; me = who;
  $('lobby').hidden = true; $('game').hidden = false;
  buildBoard(); step();
}
$('roll').onclick = () => doRoll();
$('menu').onclick = () => { $('game').hidden = true; $('lobby').hidden = false; };
let mine = 'red';
document.querySelectorAll('.pick button').forEach((b) => { b.onclick = () => { mine = b.dataset.c; document.querySelectorAll('.pick button').forEach((x) => x.setAttribute('aria-pressed', x === b)); }; });
$('m2').onclick = () => start(ORDER.filter((c) => c === mine || c === OPP[mine]), [OPP[mine]], mine);
$('m4').onclick = () => start(ORDER, ORDER.filter((c) => c !== mine), mine);
$('m4p').onclick = () => start(['red', 'green', 'yellow', 'blue'], []);

$('again').onclick = () => start(...cfg);
$('home').onclick = () => { $('result').hidden = true; $('game').hidden = true; $('lobby').hidden = false; };
