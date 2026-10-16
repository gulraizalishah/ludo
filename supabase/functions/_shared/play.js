// Server-side turn logic (pure, testable). The SERVER rolls the dice and validates every move.
import { roll, rollDice, applyMove, getLegalMoves, botPick } from './engine.js';
const nextN = (s) => (s.ev?.n ?? 0) + 1;

// action: 'roll' | 'move'. Returns the new state (with an `ev` event for animations), or null if illegal.
export function stepState(s, action, token, rng = Math.random) {
  const color = s.colors[s.turn];
  if (action === 'roll') {
    if (s.dice != null) return null;
    const d = rollDice(rng);
    return { ...roll(s, d), ev: { t: 'roll', d, color, n: nextN(s) } };
  }
  if (action === 'move') {
    if (s.dice == null || !getLegalMoves(s, s.dice).includes(token)) return null;
    return { ...applyMove(s, token, s.dice), ev: { t: 'move', i: token, d: s.dice, color, n: nextN(s) } };
  }
  return null;
}
// An idle player's turn: the server plays it for them (same bot logic as practice mode).
export const autoState = (s, rng) =>
  s.dice == null ? stepState(s, 'roll', 0, rng) : stepState(s, 'move', botPick(s, s.dice), rng);
