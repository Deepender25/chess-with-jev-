import {
  BISHOP,
  BISHOP_OFFSETS,
  BLACK,
  CASTLE_BK,
  CASTLE_BQ,
  CASTLE_WK,
  CASTLE_WQ,
  EMPTY,
  FLAG_CASTLE,
  FLAG_DOUBLE_PUSH,
  FLAG_EP,
  KING,
  KING_OFFSETS,
  KNIGHT,
  KNIGHT_OFFSETS,
  PAWN,
  PROMO_BISHOP,
  PROMO_KNIGHT,
  PROMO_QUEEN,
  PROMO_ROOK,
  QUEEN,
  ROOK,
  ROOK_OFFSETS,
  WHITE,
  encodeMove,
  makePiece,
  onBoard,
  opponent,
  pieceColor,
  pieceType,
  rankOf,
  squareOf
} from './constants.js';
import { Position } from './position.js';

const PROMOTION_CHOICES = [PROMO_QUEEN, PROMO_ROOK, PROMO_BISHOP, PROMO_KNIGHT];

/**
 * Generates pseudo-legal moves. `capturesOnly` is used by quiescence search and
 * still includes promotions, because a promotion is a forcing move even when it
 * does not capture.
 */
export function generatePseudoLegalMoves(pos: Position, capturesOnly: boolean): number[] {
  const moves: number[] = [];
  const board = pos.board;
  const us = pos.turn;
  const them = opponent(us);
  const pawnDir = us === WHITE ? 16 : -16;
  const startRank = us === WHITE ? 1 : 6;
  const promotionRank = us === WHITE ? 7 : 0;

  for (let from = 0; from < 128; from++) {
    if ((from & 0x88) !== 0) continue;
    const piece = board[from];
    if (piece === EMPTY || pieceColor(piece) !== us) continue;
    const type = pieceType(piece);

    if (type === PAWN) {
      const one = from + pawnDir;
      if (onBoard(one) && board[one] === EMPTY) {
        if (rankOf(one) === promotionRank) {
          for (const promo of PROMOTION_CHOICES) moves.push(encodeMove(from, one, promo));
        } else if (!capturesOnly) {
          moves.push(encodeMove(from, one));
          const two = from + pawnDir * 2;
          if (rankOf(from) === startRank && board[two] === EMPTY) {
            moves.push(encodeMove(from, two, 0, 0, FLAG_DOUBLE_PUSH));
          }
        }
      }

      for (const captureDir of [pawnDir - 1, pawnDir + 1]) {
        const to = from + captureDir;
        if (!onBoard(to)) continue;
        const target = board[to];
        if (target !== EMPTY && pieceColor(target) === them) {
          if (rankOf(to) === promotionRank) {
            for (const promo of PROMOTION_CHOICES) moves.push(encodeMove(from, to, promo, target));
          } else {
            moves.push(encodeMove(from, to, 0, target));
          }
        } else if (target === EMPTY && to === pos.epSquare) {
          moves.push(encodeMove(from, to, 0, makePiece(them, PAWN), FLAG_EP));
        }
      }
      continue;
    }

    if (type === KNIGHT || type === KING) {
      const offsets = type === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
      for (let i = 0; i < offsets.length; i++) {
        const to = from + offsets[i];
        if (!onBoard(to)) continue;
        const target = board[to];
        if (target === EMPTY) {
          if (!capturesOnly) moves.push(encodeMove(from, to));
        } else if (pieceColor(target) === them) {
          moves.push(encodeMove(from, to, 0, target));
        }
      }
      continue;
    }

    const dirs =
      type === BISHOP
        ? BISHOP_OFFSETS
        : type === ROOK
          ? ROOK_OFFSETS
          : [...BISHOP_OFFSETS, ...ROOK_OFFSETS];

    for (let d = 0; d < dirs.length; d++) {
      const dir = dirs[d];
      let to = from + dir;
      while (onBoard(to)) {
        const target = board[to];
        if (target === EMPTY) {
          if (!capturesOnly) moves.push(encodeMove(from, to));
        } else {
          if (pieceColor(target) === them) moves.push(encodeMove(from, to, 0, target));
          break;
        }
        to += dir;
      }
    }
  }

  if (!capturesOnly) {
    generateCastlingMoves(pos, moves);
  }

  return moves;
}
function generateCastlingMoves(pos: Position, moves: number[]): void {
  const board = pos.board;
  const us = pos.turn;
  const them = opponent(us);
  const rank = us === WHITE ? 0 : 7;
  const king = squareOf(4, rank);
  const kingsideRight = us === WHITE ? CASTLE_WK : CASTLE_BK;
  const queensideRight = us === WHITE ? CASTLE_WQ : CASTLE_BQ;

  if (pos.kingSquare[us] !== king || pos.isAttacked(king, them)) return;

  if (
    pos.castling & kingsideRight &&
    board[squareOf(5, rank)] === EMPTY &&
    board[squareOf(6, rank)] === EMPTY &&
    !pos.isAttacked(squareOf(5, rank), them) &&
    !pos.isAttacked(squareOf(6, rank), them)
  ) {
    moves.push(encodeMove(king, squareOf(6, rank), 0, 0, FLAG_CASTLE));
  }

  if (
    pos.castling & queensideRight &&
    board[squareOf(1, rank)] === EMPTY &&
    board[squareOf(2, rank)] === EMPTY &&
    board[squareOf(3, rank)] === EMPTY &&
    !pos.isAttacked(squareOf(3, rank), them) &&
    !pos.isAttacked(squareOf(2, rank), them)
  ) {
    moves.push(encodeMove(king, squareOf(2, rank), 0, 0, FLAG_CASTLE));
  }
}

/** All fully legal moves for the side to move. */
export function generateLegalMoves(pos: Position, capturesOnly = false): number[] {
  const pseudo = generatePseudoLegalMoves(pos, capturesOnly);
  const us = pos.turn;
  const them = opponent(us);
  const legal: number[] = [];

  for (let i = 0; i < pseudo.length; i++) {
    const move = pseudo[i];
    pos.makeMove(move);
    const kingSquare = pos.kingSquare[us];
    if (kingSquare < 0 || !pos.isAttacked(kingSquare, them)) {
      legal.push(move);
    }
    pos.undoMove();
  }

  return legal;
}

export function hasLegalMoves(pos: Position): boolean {
  return generateLegalMoves(pos).length > 0;
}

export function moveKey(move: number): string {
  const from = move & 0x7f;
  const to = (move >>> 7) & 0x7f;
  const promo = (move >>> 14) & 7;
  const suffix = promo === 0 ? '' : 'nbrq'[promo - 1];
  return (
    String.fromCharCode(97 + (from & 7)) +
    String.fromCharCode(49 + (from >> 4)) +
    String.fromCharCode(97 + (to & 7)) +
    String.fromCharCode(49 + (to >> 4)) +
    suffix
  );
}

/** Reference node counter used by the perft correctness tests. */
export function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves = generateLegalMoves(pos);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (let i = 0; i < moves.length; i++) {
    pos.makeMove(moves[i]);
    nodes += perft(pos, depth - 1);
    pos.undoMove();
  }
  return nodes;
}

/** Per-root-move breakdown, handy when a perft number disagrees. */
export function perftDivide(pos: Position, depth: number): Record<string, number> {
  const result: Record<string, number> = {};
  const moves = generateLegalMoves(pos);
  for (const move of moves) {
    pos.makeMove(move);
    const count = depth <= 1 ? 1 : perft(pos, depth - 1);
    pos.undoMove();
    result[moveKey(move)] = count;
  }
  return result;
}