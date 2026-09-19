import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { Position } from '../src/engine/position.js';
import { generateLegalMoves, moveKey, perft } from '../src/engine/movegen.js';
import { SearchEngine } from '../src/engine/search.js';
import { evaluate } from '../src/engine/evaluation.js';
import { squareName } from '../src/engine/constants.js';

/* -------------------------------------------------------------------------- */
/* Move generation                                                            */
/* -------------------------------------------------------------------------- */

const PERFT_SUITES: Array<{ name: string; fen: string; expected: number[] }> = [
  {
    name: 'startpos',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    expected: [20, 400, 8902, 197281, 4865609]
  },
  {
    name: 'kiwipete',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    expected: [48, 2039, 97862]
  },
  {
    name: 'position 3 (endgame, en passant)',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    expected: [14, 191, 2812, 43238]
  },
  {
    name: 'position 4 (promotions)',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    expected: [6, 264, 9467]
  },
  {
    name: 'position 5',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    expected: [44, 1486, 62379]
  },
  {
    name: 'position 6',
    fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    expected: [46, 2079, 89890]
  }
];

describe('move generation', () => {
  for (const suite of PERFT_SUITES) {
    it(`matches the reference perft counts for ${suite.name}`, () => {
      for (let depth = 1; depth <= suite.expected.length; depth++) {
        const pos = new Position(suite.fen);
        expect(perft(pos, depth), `perft(${depth})`).toBe(suite.expected[depth - 1]);
      }
    }, 90000);
  }

  it('agrees with chess.js on every legal move in randomly played games', () => {
    let seed = 20240917;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let game = 0; game < 10; game++) {
      const reference = new Chess();
      const pos = new Position(reference.fen());

      for (let ply = 0; ply < 40; ply++) {
        const uciOf = (move: number) => {
          const from = squareName(move & 0x7f);
          const to = squareName((move >>> 7) & 0x7f);
          const promo = (move >>> 14) & 7;
          return from + to + (promo === 0 ? '' : 'nbrq'[promo - 1]);
        };

        const mine = new Set(generateLegalMoves(pos).map(uciOf));
        const theirs = new Set(
          reference.moves({ verbose: true }).map((move) => move.from + move.to + (move.promotion ?? ''))
        );

        expect(mine, `game ${game} ply ${ply} on ${reference.fen()}`).toEqual(theirs);
        if (mine.size === 0) break;

        const uci = [...mine][Math.floor(next() * mine.size)];
        const played = reference.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          ...(uci.length > 4 ? { promotion: uci[4] } : {})
        });
        expect(played, `chess.js must accept ${uci}`).toBeTruthy();

        const move = generateLegalMoves(pos).find((candidate) => moveKey(candidate) === uci);
        expect(move, `engine must encode ${uci}`).toBeDefined();
        pos.makeMove(move as number);
        expect(pos.toFen()).toBe(reference.fen());
      }
    }
  }, 60000);

  it('keeps its incremental Zobrist hash in step with a freshly computed one', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const pos = new Position();

    for (let ply = 0; ply < 60; ply++) {
      const moves = generateLegalMoves(pos);
      if (moves.length === 0) break;
      pos.makeMove(moves[Math.floor(next() * moves.length)]);
      const fresh = new Position(pos.toFen());
      expect(pos.hashLo).toBe(fresh.hashLo);
      expect(pos.hashHi).toBe(fresh.hashHi);
    }
  }, 30000);
});

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/** Mirrors a FEN vertically and swaps colours, which must not change the score. */
function mirrorFen(fen: string): string {
  const [placement, turn, castling] = fen.split(' ');
  const swap = (ch: string) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase());
  const mirrored = placement
    .split('/')
    .reverse()
    .map((row) => row.replace(/[pnbrqkPNBRQK]/g, swap))
    .join('/');
  return `${mirrored} ${turn === 'w' ? 'b' : 'w'} ${castling} - 0 1`;
}

describe('evaluation', () => {
  const symmetric: string[] = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    '4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1',
    '1nb1kbn1/pppppppp/8/8/8/8/PPPPPPPP/1NB1KBN1 w - - 0 1',
    'r3k2r/ppp2ppp/2n5/3pp3/3PP3/2N5/PPP2PPP/R3K2R w KQkq - 0 1',
    '8/5k2/6p1/8/8/1P6/5K2/8 w - - 0 1'
  ];

  for (const fen of symmetric) {
    it(`is colour symmetric for ${fen}`, () => {
      expect(evaluate(new Position(fen))).toBe(evaluate(new Position(mirrorFen(fen))));
    });
  }

  it('values a queen far above a pawn', () => {
    expect(evaluate(new Position('4k3/8/8/8/8/8/8/3QK3 w - - 0 1'))).toBeGreaterThan(700);
    expect(evaluate(new Position('3qk3/8/8/8/8/8/8/4K3 w - - 0 1'))).toBeLessThan(-700);
  });
});

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

describe('search', () => {
  const engine = new SearchEngine(16);

  const findMove = (fen: string, timeMs = 1500) => {
    const pos = new Position(fen);
    const result = engine.search(pos, { timeMs, maxDepth: 10 });
    return { result, san: moveKey(result.bestMove) };
  };

  it('finds a back-rank mate in one', () => {
    const { result, san } = findMove('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
    expect(san).toBe('a1a8');
    expect(result.mateInPlies).toBe(1);
  }, 20000);

  it("finds the scholar's mate", () => {
    const { result, san } = findMove(
      'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4'
    );
    expect(san).toBe('h5f7');
    expect(result.mateInPlies).toBe(1);
  }, 20000);

  it('takes a hanging queen instead of shuffling', () => {
    const { result, san } = findMove('4k3/8/8/8/8/8/4q3/4K3 w - - 0 1');
    expect(san).toBe('e1e2');
    expect(result.score).toBeGreaterThanOrEqual(0);
  }, 20000);

  it('rescues an attacked piece while keeping the material edge', () => {
    const { result } = findMove('4k3/8/8/8/4p3/3N4/8/4K3 w - - 0 1');
    expect(result.score).toBeGreaterThan(100);
    expect(squareName(result.bestMove & 0x7f)).toBe('d3');
  }, 20000);

  it('plays a sound opening move and rates the start position as level', () => {
    const { result, san } = findMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 2000);
    expect(Math.abs(result.score)).toBeLessThan(80);
    expect(result.depth).toBeGreaterThanOrEqual(5);
    expect(['e2e4', 'd2d4', 'g1f3', 'b1c3', 'e2e3']).toContain(san);
  }, 20000);

  it('scores every root move exactly inside the root window and ranks them', () => {
    const pos = new Position('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
    const result = engine.search(pos, { timeMs: 1200, maxDepth: 8 });
    expect(result.rootMoves.filter((move) => move.exact).length).toBeGreaterThan(1);
    for (const move of result.rootMoves) {
      expect(move.score).toBeLessThanOrEqual(result.rootMoves[0].score);
    }
  }, 20000);
});