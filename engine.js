// Pure Ludo rules: blockades + "capture before you can go home". No DOM, no randomness inside.
// Token position codes:
//   -1        in base
//   0..51     on the shared 52-square loop, relative to the colour's start
//             (50 is the square before the home lane; 51 is the square before the start)
//   100..104  home lane
//   105       finished
export const COLORS = ['red', 'green', 'yellow', 'blue'];
export const START = { red: 0, green: 13, yellow: 26, blue: 39 };
export const SAFE = [0, 8, 13, 21, 26, 34, 39, 47]; // star + start squares: no blockades here
export const FINISH = 105;
export const trackIndex = (c, p) => (START[c] + p) % 52;
export const onTrack = (p) => p >= 0 && p <= 51;

export const createGame = (colors) => ({
  colors,
  tokens: Object.fromEntries(colors.map((c) => [c, [-1, -1, -1, -1]])),
  captured: Object.fromEntries(colors.map((c) => [c, false])), // has this player captured yet? (unlocks the home lane)
  out: [],                                                      // players who left the game (forfeited)
  turn: 0, dice: null, sixes: 0, winners: [],
});
export const rollDice = (rng = Math.random) => 1 + Math.floor(rng() * 6);
export const isOver = (s) => s.winners.length >= s.colors.length - 1;

// One step forward. Without a capture, a token passes its home turn-off and keeps looping.
const advance = (p, unlocked) => (p >= 100 ? p + 1 : p === 50 && unlocked ? 100 : p === 51 ? 0 : p + 1);

// A player's blockades: 2+ of his tokens on the same non-safe track square.
function groupsOf(s, c, withSafe = false) {
  const m = {};
  s.tokens[c].forEach((p, i) => {
    if (!onTrack(p)) return;
    const a = trackIndex(c, p);
    if (withSafe || !SAFE.includes(a)) (m[a] = m[a] || []).push(i);
  });
  return Object.entries(m).filter(([, ids]) => ids.length > 1).map(([a, ids]) => ({ color: c, abs: +a, ids }));
}
const stacksOf = (s, c) => groupsOf(s, c);
export const blockades = (s) => s.colors.flatMap((c) => stacksOf(s, c));
const enemyBlock = (s, c, abs) => blockades(s).find((b) => b.color !== c && b.abs === abs);

// Where would token i of colour c land with roll d? null if illegal, else { np, cap }.
function target(s, c, i, d) {
  const p = s.tokens[c][i];
  if (p === FINISH) return null;
  if (p === -1) return d === 6 ? { np: 0 } : null;
  let q = p, cap = null;
  for (let k = 1; k <= d; k++) {
    if (q === FINISH) return null;                            // exact roll needed to finish
    q = advance(q, s.captured[c]);
    if (!onTrack(q)) continue;
    const b = enemyBlock(s, c, trackIndex(c, q));
    if (!b) continue;
    if (k < d) return null;                                   // can't pass through a blockade
    // An equal-size group can capture it, even from a star square (where it isn't a blockade itself).
    const mine = groupsOf(s, c, true).find((m) => m.ids.includes(i));
    if (!mine || mine.ids.length !== b.ids.length) return null;
    if (SAFE.includes(trackIndex(c, p)) && stacksOf(s, c).length) return null; // would make a 2nd blockade
    cap = b;
  }
  if (!cap && onTrack(q)) {                                    // one blockade per player
    const a = trackIndex(c, q);
    const joins = s.tokens[c].some((t, j) => j !== i && onTrack(t) && trackIndex(c, t) === a);
    if (joins && !SAFE.includes(a) &&
        stacksOf(s, c).some((m) => m.abs !== a && !(m.ids.length === 2 && m.ids.includes(i)))) return null;
  }
  return { np: q, cap };
}

export function getLegalMoves(s, d) {
  const c = s.colors[s.turn];
  return s.tokens[c].map((_, i) => i).filter((i) => target(s, c, i, d));
}

function nextTurn(s) {
  let t = s.turn;
  const gone = (c) => s.winners.includes(c) || (s.out || []).includes(c);
  do { t = (t + 1) % s.colors.length; } while (gone(s.colors[t]));
  return { ...s, turn: t, dice: null, sixes: 0 };
}

export function roll(s, d) {
  s = { ...s, dice: d, sixes: d === 6 ? s.sixes + 1 : 0 };
  return s.sixes === 3 || !getLegalMoves(s, d).length ? nextTurn(s) : s;
}

export function applyMove(s, i, d) {
  const c = s.colors[s.turn];
  const { np, cap } = target(s, c, i, d);
  const tokens = Object.fromEntries(Object.entries(s.tokens).map(([k, v]) => [k, [...v]]));
  let captured = !!cap;
  if (cap) {
    // The whole attacking group moves together and the blockade goes back to base.
    groupsOf(s, c, true).find((m) => m.ids.includes(i)).ids.forEach((j) => { tokens[c][j] = np; });
    cap.ids.forEach((j) => { tokens[cap.color][j] = -1; });
  } else {
    tokens[c][i] = np;
    if (onTrack(np) && !SAFE.includes(trackIndex(c, np))) {
      for (const o of s.colors) {
        if (o === c) continue;
        tokens[o] = tokens[o].map((q) =>
          onTrack(q) && trackIndex(o, q) === trackIndex(c, np) ? ((captured = true), -1) : q);
      }
    }
  }
  const won = tokens[c].every((q) => q === FINISH);
  const winners = won ? [...s.winners, c] : s.winners;
  const n = { ...s, tokens, winners, dice: null, captured: { ...s.captured, [c]: s.captured[c] || captured } };
  return (d === 6 || captured) && !won ? n : nextTurn(n);
}

// Bot: capture > finish > leave base > front-most token.
export function botPick(s, d) {
  const c = s.colors[s.turn];
  const base = (st, col) => st.tokens[col].filter((q) => q === -1).length;
  const score = (i) => {
    const before = s.tokens[c][i], n = applyMove(s, i, d);
    const hit = s.colors.some((o) => o !== c && base(n, o) > base(s, o));
    return (hit ? 1000 : 0) + (n.tokens[c][i] === FINISH ? 500 : 0) + (before === -1 ? 300 : 0) + (before >= 100 ? 200 : before);
  };
  return getLegalMoves(s, d).sort((a, b) => score(b) - score(a))[0];
}

// Squares a token passes through (in order) when it moves with roll d. Used for the hop animation.
export function movePath(s, i, d) {
  const c = s.colors[s.turn], p = s.tokens[c][i];
  if (p === -1) return [0];
  const out = [];
  for (let k = 0, q = p; k < d; k++) out.push((q = advance(q, s.captured[c])));
  return out;
}

// A player who walks away: their pieces leave the board (so they can never block anyone), their turns are
// skipped, and when only one player is left, that player wins.
export function forfeit(s, color) {
  const out = [...(s.out || []), color];
  const n = { ...s, out, tokens: { ...s.tokens, [color]: [-1, -1, -1, -1] } };
  const left = s.colors.filter((c) => !out.includes(c) && !s.winners.includes(c));
  if (left.length === 1 && !s.winners.length) return { ...n, winners: [left[0]], dice: null };
  return s.colors[s.turn] === color ? nextTurn(n) : n;
}
