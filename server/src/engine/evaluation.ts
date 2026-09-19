import {
  BISHOP,
  BLACK,
  EMPTY,
  KING,
  KNIGHT,
  PAWN,
  QUEEN,
  ROOK,
  WHITE,
  fileOf,
  makePiece,
  onBoard,
  pieceColor,
  pieceType,
  rankOf,
  squareOf
} from './constants.js';
import { Position } from './position.js';
import {
  BISHOP_TABLE,
  KING_EG_TABLE,
  KING_MG_TABLE,
  KNIGHT_TABLE,
  PASSED_PAWN_EG,
  PASSED_PAWN_MG,
  PAWN_TABLE,
  PIECE_VALUE,
  QUEEN_TABLE,
  ROOK_TABLE
} from './pst.js';

/** Table lookup index per 0x88 square, precomputed for both colours. */
const PST_INDEX_WHITE = new Int16Array(128);
const PST_INDEX_BLACK = new Int16Array(128);
for (let sq = 0; sq < 128; sq++) {
  if ((sq & 0x88) !== 0) continue;
  const file = fileOf(sq);
  const rank = rankOf(sq);
  PST_INDEX_WHITE[sq] = (7 - rank) * 8 + file;
  PST_INDEX_BLACK[sq] = rank * 8 + file;
}

/* Scratch buffers, reused between calls. `evaluate` is not reentrant, which is
 * fine: it is only ever called at leaf nodes of the single-threaded search. */
const whitePawnMinRank = new Int8Array(8);
const blackPawnMaxRank = new Int8Array(8);
const whitePawnCount = new Int8Array(8);
const blackPawnCount = new Int8Array(8);
const whitePawnSquares: number[][] = [[], [], [], [], [], [], [], []];
const blackPawnSquares: number[][] = [[], [], [], [], [], [], [], []];
const whiteRooks: number[] = [];
const blackRooks: number[] = [];
const whiteSliders: number[] = [];
const blackSliders: number[] = [];

const MOBILITY_MG: number[] = [0, 0, 4, 3, 2, 1, 0];
const MOBILITY_EG: number[] = [0, 0, 3, 3, 3, 1, 0];

/**
 * A white pawn is passed when no black pawn on its own or an adjacent file is
 * further up the board, i.e. at a higher rank.
 */
function isPassedForWhite(rank: number, file: number): boolean {
  for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1); f++) {
    if (blackPawnMaxRank[f] > rank) return false;
  }
  return true;
}

/**
 * Black travels towards rank 1, so the white pawn that blocks it is the one
 * with the *lowest* rank on a neighbouring file, not the highest.
 */
function isPassedForBlack(rank: number, file: number): boolean {
  for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1); f++) {
    if (whitePawnMinRank[f] < rank) return false;
  }
  return true;
}

/** Pawn-shelter bonus for a king, plus a penalty for a bare file beside it. */
function kingShelter(kingSquare: number, colour: 0 | 1, board: Int8Array): number {
  if (kingSquare < 0) return 0;
  const file = fileOf(kingSquare);
  const rank = rankOf(kingSquare);
  const dir = colour === WHITE ? 1 : -1;
  const friendlyPawn = makePiece(colour, PAWN);
  let bonus = 0;

  for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1); f++) {
    let hasShield = false;
    for (let step = 1; step <= 2; step++) {
      const sq = squareOf(f, rank + dir * step);
      if (!onBoard(sq)) break;
      if (board[sq] === friendlyPawn) {
        hasShield = true;
        break;
      }
    }
    if (hasShield) bonus += 10;
    else if (whitePawnCount[f] === 0 && blackPawnCount[f] === 0) bonus -= 18;
  }

  return bonus;
}
/**
 * Static evaluation in centipawns, from the point of view of the side to move
 * (the negamax convention).
 *
 * Terms: material, tapered piece-square tables, bishop pair, rooks on open and
 * semi-open files, pawn structure (doubled / isolated / passed), mobility for
 * knights and sliders, a modest king-shelter term, and tempo.
 */
export function evaluate(pos: Position): number {
  const board = pos.board;

  let mgWhite = 0;
  let egWhite = 0;
  let mgBlack = 0;
  let egBlack = 0;

  let phase = 0;
  let whiteBishops = 0;
  let blackBishops = 0;

  whitePawnMinRank.fill(8);
  blackPawnMaxRank.fill(-1);
  whitePawnCount.fill(0);
  blackPawnCount.fill(0);
  for (let i = 0; i < 8; i++) {
    whitePawnSquares[i].length = 0;
    blackPawnSquares[i].length = 0;
  }
  whiteRooks.length = 0;
  blackRooks.length = 0;
  whiteSliders.length = 0;
  blackSliders.length = 0;

  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const piece = board[sq];
    if (piece === EMPTY) continue;

    const colour = pieceColor(piece);
    const type = pieceType(piece);
    const value = PIECE_VALUE[type];
    const isWhite = colour === WHITE;
    const index = isWhite ? PST_INDEX_WHITE[sq] : PST_INDEX_BLACK[sq];

    let mg = value;
    let eg = value;

    switch (type) {
      case PAWN:
        mg += PAWN_TABLE[index];
        eg += PAWN_TABLE[index];
        break;
      case KNIGHT:
        mg += KNIGHT_TABLE[index];
        eg += KNIGHT_TABLE[index];
        break;
      case BISHOP:
        mg += BISHOP_TABLE[index];
        eg += BISHOP_TABLE[index];
        break;
      case ROOK:
        mg += ROOK_TABLE[index];
        eg += ROOK_TABLE[index];
        break;
      case QUEEN:
        mg += QUEEN_TABLE[index];
        eg += QUEEN_TABLE[index];
        break;
      case KING:
        mg += KING_MG_TABLE[index];
        eg += KING_EG_TABLE[index];
        break;
      default:
        break;
    }

    if (isWhite) {
      mgWhite += mg;
      egWhite += eg;
    } else {
      mgBlack += mg;
      egBlack += eg;
    }

    if (type === QUEEN) phase += 4;
    else if (type === ROOK) phase += 2;
    else if (type === BISHOP || type === KNIGHT) phase += 1;

    if (type === BISHOP) {
      if (isWhite) whiteBishops++;
      else blackBishops++;
    } else if (type === PAWN) {
      const file = fileOf(sq);
      const rank = rankOf(sq);
      if (isWhite) {
        whitePawnCount[file]++;
        if (rank < whitePawnMinRank[file]) whitePawnMinRank[file] = rank;
        whitePawnSquares[file].push(sq);
      } else {
        blackPawnCount[file]++;
        if (rank > blackPawnMaxRank[file]) blackPawnMaxRank[file] = rank;
        blackPawnSquares[file].push(sq);
      }
    } else if (type !== KING) {
      if (isWhite) {
        whiteSliders.push(sq);
        if (type === ROOK) whiteRooks.push(sq);
      } else {
        blackSliders.push(sq);
        if (type === ROOK) blackRooks.push(sq);
      }
    }
  }


  /* Symmetric terms, accumulated as a white-minus-black delta. */
  let mgDelta = 0;
  let egDelta = 0;

  if (whiteBishops >= 2) {
    mgDelta += 25;
    egDelta += 45;
  }
  if (blackBishops >= 2) {
    mgDelta -= 25;
    egDelta -= 45;
  }

  for (const sq of whiteSliders) {
    const type = pieceType(board[sq]);
    const moves = pos.mobilityCount(sq, board[sq]);
    mgDelta += MOBILITY_MG[type] * moves;
    egDelta += MOBILITY_EG[type] * moves;
  }
  for (const sq of blackSliders) {
    const type = pieceType(board[sq]);
    const moves = pos.mobilityCount(sq, board[sq]);
    mgDelta -= MOBILITY_MG[type] * moves;
    egDelta -= MOBILITY_EG[type] * moves;
  }

  for (const sq of whiteRooks) {
    const file = fileOf(sq);
    if (whitePawnCount[file] === 0 && blackPawnCount[file] === 0) {
      mgDelta += 22;
      egDelta += 12;
    } else if (whitePawnCount[file] === 0) {
      mgDelta += 11;
      egDelta += 6;
    }
  }
  for (const sq of blackRooks) {
    const file = fileOf(sq);
    if (whitePawnCount[file] === 0 && blackPawnCount[file] === 0) {
      mgDelta -= 22;
      egDelta -= 12;
    } else if (blackPawnCount[file] === 0) {
      mgDelta -= 11;
      egDelta -= 6;
    }
  }

  for (let file = 0; file < 8; file++) {
    if (whitePawnCount[file] > 1) {
      const extra = whitePawnCount[file] - 1;
      mgDelta -= 12 * extra;
      egDelta -= 20 * extra;
    }
    if (blackPawnCount[file] > 1) {
      const extra = blackPawnCount[file] - 1;
      mgDelta += 12 * extra;
      egDelta += 20 * extra;
    }

    const whiteNeighbours =
      (file > 0 ? whitePawnCount[file - 1] : 0) + (file < 7 ? whitePawnCount[file + 1] : 0);
    if (whitePawnCount[file] > 0 && whiteNeighbours === 0) {
      mgDelta -= 14 * whitePawnCount[file];
      egDelta -= 18 * whitePawnCount[file];
    }

    const blackNeighbours =
      (file > 0 ? blackPawnCount[file - 1] : 0) + (file < 7 ? blackPawnCount[file + 1] : 0);
    if (blackPawnCount[file] > 0 && blackNeighbours === 0) {
      mgDelta += 14 * blackPawnCount[file];
      egDelta += 18 * blackPawnCount[file];
    }

    for (const sq of whitePawnSquares[file]) {
      const rank = rankOf(sq);
      if (isPassedForWhite(rank, file)) {
        mgDelta += PASSED_PAWN_MG[rank];
        egDelta += PASSED_PAWN_EG[rank];
      }
    }
    for (const sq of blackPawnSquares[file]) {
      const rank = rankOf(sq);
      if (isPassedForBlack(rank, file)) {
        mgDelta -= PASSED_PAWN_MG[7 - rank];
        egDelta -= PASSED_PAWN_EG[7 - rank];
      }
    }
  }

  mgDelta += kingShelter(pos.kingSquare[WHITE], WHITE, board);
  mgDelta -= kingShelter(pos.kingSquare[BLACK], BLACK, board);

  const mgWeight = Math.min(24, phase) / 24;
  const egWeight = 1 - mgWeight;

  const whiteScore = mgWhite * mgWeight + egWhite * egWeight;
  const blackScore = mgBlack * mgWeight + egBlack * egWeight;
  const delta = mgDelta * mgWeight + egDelta * egWeight;

  const score = Math.round(whiteScore - blackScore + delta) + (pos.turn === WHITE ? 12 : -12);
  return pos.turn === WHITE ? score : -score;
}