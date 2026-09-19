import { Chess } from 'chess.js';
import { moveFrom, movePromotion, moveTo, promotionLetter, squareName } from '../engine/constants.js';
import type { Position } from '../engine/position.js';

/**
 * SAN rendering.
 *
 * `chess.js` is used here on purpose: these calls happen a handful of times per
 * move at the edge of the system (to label candidates for the UI and for Jev's
 * state), never inside the search. It keeps the engine free of notation
 * concerns while guaranteeing the SAN the extension draws is exactly the SAN a
 * chess player expects, including disambiguation and `+`/`#` suffixes.
 */
export function moveToSan(fen: string, move: number): string | null {
  try {
    const chess = new Chess(fen);
    const promotion = movePromotion(move);
    const result = chess.move({
      from: squareName(moveFrom(move)),
      to: squareName(moveTo(move)),
      ...(promotion === 0 ? {} : { promotion: promotionLetter(promotion) })
    });
    return result ? result.san : null;
  } catch {
    return null;
  }
}

export interface RenderedPv {
  san: string[];
  text: string;
}

/** Renders a principal variation, stopping at the first move chess.js rejects. */
export function renderPv(fen: string, moves: number[], maxPlies = 8): RenderedPv {
  const san: string[] = [];
  try {
    const chess = new Chess(fen);
    for (const move of moves.slice(0, maxPlies)) {
      const promotion = movePromotion(move);
      const result = chess.move({
        from: squareName(moveFrom(move)),
        to: squareName(moveTo(move)),
        ...(promotion === 0 ? {} : { promotion: promotionLetter(promotion) })
      });
      if (!result) break;
      san.push(result.san);
    }
  } catch {
    // A malformed FEN simply yields no PV.
  }
  const text = san
    .map((entry, index) => (index % 2 === 0 ? `${Math.floor(index / 2) + 1}.${entry}` : entry))
    .join(' ');
  return { san, text };
}

/** Applies a move to a FEN, returning the resulting FEN or null when illegal. */
export function applyMoveToFen(fen: string, move: number): string | null {
  try {
    const chess = new Chess(fen);
    const promotion = movePromotion(move);
    const result = chess.move({
      from: squareName(moveFrom(move)),
      to: squareName(moveTo(move)),
      ...(promotion === 0 ? {} : { promotion: promotionLetter(promotion) })
    });
    return result ? chess.fen() : null;
  } catch {
    return null;
  }
}

/** Positions arising after each root move, for one-ply threat analysis. */
export function childFen(fen: string, move: number): string | null {
  return applyMoveToFen(fen, move);
}

export function fenOf(pos: Position): string {
  return pos.toFen();
}