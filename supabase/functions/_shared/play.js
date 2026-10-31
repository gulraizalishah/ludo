// Server-side turn logic (pure, testable). The SERVER rolls the dice and validates every move.
import { roll, rollDice, applyMove, getLegalMoves, botPick, forfeit } from './engine.js';
const nextN = (s) => (s.ev?.n ?? 0) + 1;
export const IDLE_LIMIT = 6;   // server-played actions in a row before a player is considered gone (~3 minutes)

// action: 'roll' | 'move'. Returns the new state (with an `ev` event for animations), or null if illegal.
// A real player acting resets their idle counter.
export function stepState(s, action, token, rng = Math.random) {
  const color = s.colors[s.turn], idle = { ...(s.idle || {}), [color]: 0 };
  if (action === 'roll') {
    if (s.dice != null) return null;
    const d = rollDice(rng);
    return { ...roll(s, d), idle, ev: { t: 'roll', d, color, n: nextN(s) } };
  }
  if (action === 'move') {
    if (s.dice == null || !getLegalMoves(s, s.dice).includes(token)) return null;
    return { ...applyMove(s, token, s.dice), idle, ev: { t: 'move', i: token, d: s.dice, color, n: nextN(s) } };
  }
  return null;
}
// An idle player's turn: the server plays it for them. After IDLE_LIMIT in a row they forfeit.
export function autoState(s, rng) {
  const color = s.colors[s.turn], count = (s.idle?.[color] || 0) + 1;
  const n = s.dice == null ? stepState(s, 'roll', 0, rng) : stepState(s, 'move', botPick(s, s.dice), rng);
  if (count < IDLE_LIMIT) return { ...n, idle: { ...n.idle, [color]: count } };
  return { ...forfeit(n, color), idle: { ...n.idle, [color]: count }, ev: { t: 'forfeit', forfeit: color, n: nextN(s) } };
}
