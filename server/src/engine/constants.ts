/**
 * Board representation primitives.
 *
 * The board is 0x88: squares are `rank * 16 + file`, so `a1 = 0`, `h1 = 7`,
 * `a8 = 112`, `h8 = 119`. A square is on the board exactly when
 * `(square & 0x88) === 0`, which lets sliding-piece loops detect the board edge
 * with a single mask test instead of bounds arithmetic.
 */

export type Color = 0 | 1;
export const WHITE: Color = 0;
export const BLACK: Color = 1;

/** Piece codes. White pieces are 1..6, black pieces are 9..14. */
export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const W_PAWN = 1;
export const W_KNIGHT = 2;
export const W_BISHOP = 3;
export const W_ROOK = 4;
export const W_QUEEN = 5;
export const W_KING = 6;
export const B_PAWN = 9;
export const B_KNIGHT = 10;
export const B_BISHOP = 11;
export const B_ROOK = 12;
export const B_QUEEN = 13;
export const B_KING = 14;

export function pieceColor(piece: number): Color {
  return piece >= 9 ? BLACK : WHITE;
}

/** 1..6 for every piece, regardless of colour. */
export function pieceType(piece: number): number {
  return piece >= 9 ? piece - 8 : piece;
}

/** Builds the piece code for `color` + `type` (1..6). */
export function makePiece(color: Color, type: number): number {
  return color === WHITE ? type : type + 8;
}

export function opponent(color: Color): Color {
  return color === WHITE ? BLACK : WHITE;
}

/** a1 = 0 ... h8 = 119 in 0x88 layout. */
export function squareOf(file: number, rank: number): number {
  return rank * 16 + file;
}

export function fileOf(square: number): number {
  return square & 7;
}

export function rankOf(square: number): number {
  return square >> 4;
}

export function onBoard(square: number): boolean {
  return (square & 0x88) === 0;
}

/** "e4" <-> 0x88 index. */
export function squareName(square: number): string {
  return String.fromCharCode(97 + fileOf(square)) + String.fromCharCode(49 + rankOf(square));
}

export function nameToSquare(name: string): number {
  const file = name.charCodeAt(0) - 97;
  const rank = name.charCodeAt(1) - 49;
  return squareOf(file, rank);
}

/* -------------------------------------------------------------------------- */
/* Move encoding                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A move is packed into one integer:
 *   bits  0..6  from square
 *   bits  7..13 to square
 *   bits 14..16 promotion (0 none, 1 queen, 2 rook, 3 bishop, 4 knight)
 *   bit  17     en passant
 *   bit  18     castling
 *   bit  19     double pawn push
 *   bits 20..24 captured piece code (0 when nothing is captured)
 */
export const PROMO_NONE = 0;
export const PROMO_QUEEN = 1;
export const PROMO_ROOK = 2;
export const PROMO_BISHOP = 3;
export const PROMO_KNIGHT = 4;

export const FLAG_EP = 1 << 17;
export const FLAG_CASTLE = 1 << 18;
export const FLAG_DOUBLE_PUSH = 1 << 19;

export function encodeMove(
  from: number,
  to: number,
  promotion: number = PROMO_NONE,
  captured: number = 0,
  flags: number = 0
): number {
  return (
    (from & 0x7f) |
    ((to & 0x7f) << 7) |
    ((promotion & 7) << 14) |
    flags |
    ((captured & 0x1f) << 20)
  );
}

export function moveFrom(move: number): number {
  return move & 0x7f;
}

export function moveTo(move: number): number {
  return (move >>> 7) & 0x7f;
}

export function movePromotion(move: number): number {
  return (move >>> 14) & 7;
}

export function moveCaptured(move: number): number {
  return (move >>> 20) & 0x1f;
}

export function isEnPassant(move: number): boolean {
  return (move & FLAG_EP) !== 0;
}

export function isCastle(move: number): boolean {
  return (move & FLAG_CASTLE) !== 0;
}

export function isDoublePush(move: number): boolean {
  return (move & FLAG_DOUBLE_PUSH) !== 0;
}

/** Promotion piece code (1..4) -> the piece type it becomes (2..5). */
export function promotionPieceType(promotion: number): number {
  switch (promotion) {
    case PROMO_KNIGHT:
      return KNIGHT;
    case PROMO_BISHOP:
      return BISHOP;
    case PROMO_ROOK:
      return ROOK;
    default:
      return QUEEN;
  }
}

/** Promotion letter used by chess.js / SAN ("q", "r", "b", "n"). */
export function promotionLetter(promotion: number): string {
  switch (promotion) {
    case PROMO_ROOK:
      return 'r';
    case PROMO_BISHOP:
      return 'b';
    case PROMO_KNIGHT:
      return 'n';
    default:
      return 'q';
  }
}

/* -------------------------------------------------------------------------- */
/* Movement offsets (0x88)                                                    */
/* -------------------------------------------------------------------------- */

export const KNIGHT_OFFSETS: number[] = [18, 33, 31, 14, -14, -31, -33, -18];
export const KING_OFFSETS: number[] = [-17, -16, -15, -1, 1, 15, 16, 17];
export const BISHOP_OFFSETS: number[] = [-17, -15, 15, 17];
export const ROOK_OFFSETS: number[] = [-16, -1, 1, 16];

/** Castling-rights bits. */
export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;

export const PIECE_LETTER: Record<number, string> = {
  [W_PAWN]: 'P',
  [W_KNIGHT]: 'N',
  [W_BISHOP]: 'B',
  [W_ROOK]: 'R',
  [W_QUEEN]: 'Q',
  [W_KING]: 'K',
  [B_PAWN]: 'p',
  [B_KNIGHT]: 'n',
  [B_BISHOP]: 'b',
  [B_ROOK]: 'r',
  [B_QUEEN]: 'q',
  [B_KING]: 'k'
};

export const LETTER_PIECE: Record<string, number> = {
  P: W_PAWN,
  N: W_KNIGHT,
  B: W_BISHOP,
  R: W_ROOK,
  Q: W_QUEEN,
  K: W_KING,
  p: B_PAWN,
  n: B_KNIGHT,
  b: B_BISHOP,
  r: B_ROOK,
  q: B_QUEEN,
  k: B_KING
};
