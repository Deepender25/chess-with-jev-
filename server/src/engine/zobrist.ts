/**
 * Zobrist hashing tables.
 *
 * The engine keeps two independent 32-bit hashes (`lo` and `hi`) per position so
 * that a transposition-table probe can verify a hit with the second half of the
 * key instead of trusting a single 32-bit index. Both halves are maintained
 * incrementally in `Position.makeMove`/`Position.undoMove`.
 *
 * The tables are generated at module load from a fixed seed, so every process
 * (and every test) sees identical keys.
 */

/** Deterministic 32-bit PRNG (mulberry32) so tables are stable across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const rand = mulberry32(0x9e3779b9);

/** Piece key tables: index by piece code (0..14) then 0x88 square. */
export const Z_PIECE_LO: number[][] = [];
export const Z_PIECE_HI: number[][] = [];
for (let p = 0; p < 15; p++) {
  const lo: number[] = [];
  const hi: number[] = [];
  for (let sq = 0; sq < 128; sq++) {
    lo.push(rand() >>> 0);
    hi.push(rand() >>> 0);
  }
  Z_PIECE_LO.push(lo);
  Z_PIECE_HI.push(hi);
}

/** Castling-rights keys, indexed by the 4-bit rights mask. */
export const Z_CASTLE_LO: number[] = [];
export const Z_CASTLE_HI: number[] = [];
for (let i = 0; i < 16; i++) {
  Z_CASTLE_LO.push(rand() >>> 0);
  Z_CASTLE_HI.push(rand() >>> 0);
}

/** En-passant file keys. */
export const Z_EP_LO: number[] = [];
export const Z_EP_HI: number[] = [];
for (let i = 0; i < 8; i++) {
  Z_EP_LO.push(rand() >>> 0);
  Z_EP_HI.push(rand() >>> 0);
}

/** Side-to-move key, folded in whenever black is to move. */
export const Z_SIDE_LO: number = rand() >>> 0;
export const Z_SIDE_HI: number = rand() >>> 0;
