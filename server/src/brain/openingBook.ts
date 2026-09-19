import { Chess } from 'chess.js';

/**
 * A small, deliberately conservative opening book.
 *
 * The book exists so the engine never wastes its search on well-known theory
 * and never improvises a bad first few moves. It is written as SAN *lines* —
 * the way a human writes opening theory — and the position index is derived by
 * replaying every line with chess.js at construction time. Anything illegal is
 * dropped and reported, and `tests/openingBook.test.ts` asserts that nothing is
 * dropped, so a typo can never silently ship.
 */

/** Mainline opening theory, kept short and unambiguous on purpose. */
export const BOOK_LINES: string[] = [
  // 1.e4 e5 — Open games
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7',
  'e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4',
  'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6',
  'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5',
  'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nc3 Bb4',
  'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5',
  'e4 e5 Nf3 d6 d4 Nf6 Nc3 Nbd7',
  'e4 e5 Nc3 Nf6 f4 d5',
  // 1.e4 c5 — Sicilian
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6',
  'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5',
  'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6',
  'e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7',
  // 1.e4 e6 / c6 / d5 / g6 — Semi-open
  'e4 e6 d4 d5 Nc3 Nf6 e5 Nfd7',
  'e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7',
  'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5',
  'e4 c6 d4 d5 e5 Bf5',
  'e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6',
  'e4 g6 d4 Bg7 Nc3 d6 Nf3 Nf6',
  // 1.d4 d5 — Closed games
  'd4 d5 c4 e6 Nc3 Nf6 Nf3 Be7 Bg5 O-O',
  'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5',
  'd4 d5 c4 e6 Nc3 c5 cxd5 exd5',
  'd4 d5 Nf3 Nf6 c4 e6 Nc3 Be7',
  'd4 d5 e3 Nf6 Nf3 e6 Bd3 c5',
  // 1.d4 Nf6 — Indian defences
  'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5',
  'd4 Nf6 c4 e6 Nf3 b6 g3 Bb7 Bg2 Be7',
  'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O',
  'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5',
  'd4 Nf6 c4 c5 d5 b5 cxb5 a6',
  'd4 f5 g3 Nf6 Bg2 g6 Nf3 Bg7',
  // Flank openings
  'Nf3 d5 g3 Nf6 Bg2 c5 O-O Nc6',
  'Nf3 Nf6 c4 e6 Nc3 d5 d4 Be7',
  'c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5',
  'c4 c5 Nf3 Nf6 Nc3 Nc6 g3 g6',
  'd4 d5 c4 Nf6 Nf3 e6 Nc3 Be7',
  'e4 e5 Nf3 Nc6 Bb5 Bc5 O-O Nd4'
];

interface BookEntry {
  /** SAN moves worth playing from this position. */
  moves: string[];
}

/** Position key: the first four FEN fields, which ignore the move counters. */
function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export class OpeningBook {
  private readonly index = new Map<string, string[]>();
  private readonly rejected: string[] = [];

  constructor(lines: string[] = BOOK_LINES) {
    for (const line of lines) {
      this.registerLine(line);
    }
  }

  private registerLine(line: string): void {
    const chess = new Chess();
    const moves = line.trim().split(/\s+/).filter(Boolean);
    for (const san of moves) {
      const key = positionKey(chess.fen());
      let result;
      try {
        result = chess.move(san);
      } catch {
        result = null;
      }
      if (!result) {
        this.rejected.push(`${line} (failed at ${san})`);
        return;
      }
      const bucket = this.index.get(key) ?? [];
      if (!bucket.includes(result.san)) bucket.push(result.san);
      this.index.set(key, bucket);
    }
  }

  /** Lines that could not be replayed; must stay empty. */
  public getRejected(): string[] {
    return [...this.rejected];
  }

  public size(): number {
    return this.index.size;
  }

  /** Book moves for this position, or an empty array. */
  public movesFor(fen: string): string[] {
    return this.index.get(positionKey(fen)) ?? [];
  }

  /**
   * Deterministically picks one of the book moves for this position, so a given
   * game always follows the same line but different games vary.
   */
  public pick(fen: string, plyIndex: number): string | null {
    const moves = this.movesFor(fen);
    if (moves.length === 0) return null;
    const seed = Number.parseInt(fen.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6), 36);
    const mixed = (Number.isFinite(seed) ? seed : 0) + plyIndex;
    return moves[Math.abs(mixed) % moves.length];
  }
}

export { positionKey };
