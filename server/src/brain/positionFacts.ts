import {
  BISHOP,
  BLACK,
  EMPTY,
  KING,
  KNIGHT,
  PAWN,
  PIECE_LETTER,
  QUEEN,
  ROOK,
  WHITE,
  fileOf,
  makePiece,
  onBoard,
  opponent,
  pieceColor,
  pieceType,
  rankOf,
  squareName,
  squareOf
} from '../engine/constants.js';
import type { Color } from '../engine/constants.js';
import type { Position } from '../engine/position.js';
import { PIECE_VALUE } from '../engine/pst.js';

export type GamePhase = 'opening' | 'middlegame' | 'endgame';

export interface KingFacts {
  square: string;
  /** Opposing pieces attacking the king's 3x3 ring. */
  attackers: number;
  /** Own pawns directly in front of the king. */
  shieldPawns: number;
  /** Files beside the king with no pawn of either colour. */
  openFilesBeside: number;
  /** Squares the king could legally step to right now. */
  escapeSquares: number;
  exposure: string;
}

export interface PassedPawnFact {
  square: string;
  side: 'w' | 'b';
  /** Plies needed to reach the promotion square. */
  stepsToPromotion: number;
}

export interface HangingPieceFact {
  square: string;
  piece: string;
  side: 'w' | 'b';
  value: number;
  defended: boolean;
}

export interface PositionFacts {
  fen: string;
  sideToMove: 'w' | 'b';
  phase: GamePhase;
  fullmoveNumber: number;
  /** Material balance in pawns, positive when the side to move is ahead. */
  materialDeltaPawns: number;
  materialLabel: string;
  ourKing: KingFacts;
  enemyKing: KingFacts;
  passedPawns: PassedPawnFact[];
  hangingPieces: HangingPieceFact[];
  pieceCount: number;
  isInCheck: boolean;
  moveCount: number;
}

const PIECE_NAME: Record<string, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king'
};

const KNIGHT_OFFSETS = [18, 33, 31, 14, -14, -31, -33, -18];
const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];

/** Every square holding a piece of colour `by` that attacks `target`. */
function findAttackers(pos: Position, target: number, by: Color): number[] {
  const attackers: number[] = [];
  const board = pos.board;
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const piece = board[sq];
    if (piece === EMPTY || pieceColor(piece) !== by) continue;
    if (pieceAttacksSquare(pos, sq, piece, target)) attackers.push(sq);
  }
  return attackers;
}

/** Does the piece on `from` attack `target` on the current board? */
function pieceAttacksSquare(pos: Position, from: number, piece: number, target: number): boolean {
  const type = pieceType(piece);
  const colour = pieceColor(piece);
  const board = pos.board;

  if (type === PAWN) {
    const dir = colour === WHITE ? 16 : -16;
    return target === from + dir - 1 || target === from + dir + 1;
  }

  if (type === KNIGHT || type === KING) {
    const offsets = type === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
    for (const offset of offsets) {
      if (from + offset === target) return true;
    }
    return false;
  }

  const dirs: number[] = [];
  if (type === BISHOP || type === QUEEN) dirs.push(-17, -15, 15, 17);
  if (type === ROOK || type === QUEEN) dirs.push(-16, -1, 1, 16);

  for (const dir of dirs) {
    let sq = from + dir;
    while (onBoard(sq)) {
      if (sq === target) return true;
      if (board[sq] !== EMPTY) break;
      sq += dir;
    }
  }
  return false;
}

/** Non-pawn material present at the start of a game, in centipawns. */
const START_NON_PAWN_MATERIAL = 2 * (2 * 320 + 2 * 330 + 2 * 500 + 900);

function describeKing(square: string, castled: boolean, attackers: number, shield: number, openFiles: number, escapes: number): string {
  if (castled && shield >= 2 && attackers === 0) {
    return `Safe on ${square}: castled behind ${shield} pawn(s), nothing attacking.`;
  }
  if (attackers >= 3) {
    return `Under heavy fire on ${square}: ${attackers} enemy piece(s) attacking the king's zone.`;
  }
  if (attackers >= 1) {
    return `Under pressure on ${square}: ${attackers} enemy piece(s) attacking the king's zone.`;
  }
  if (shield === 0 || openFiles >= 2) {
    return `Exposed on ${square}: no pawn cover nearby (${openFiles} bare file(s)).`;
  }
  return `Reasonably safe on ${square}: ${shield} shield pawn(s), ${escapes} escape square(s).`;
}

function kingFactsFor(pos: Position, colour: Color, square: number): KingFacts {
  if (square < 0) {
    return {
      square: '-',
      attackers: 0,
      shieldPawns: 0,
      openFilesBeside: 0,
      escapeSquares: 0,
      exposure: 'King is not on the board.'
    };
  }

  const board = pos.board;
  const attackerColour = opponent(colour);
  const file = fileOf(square);
  const rank = rankOf(square);
  const name = squareName(square);

  const zone = new Set<number>();
  for (const offset of [-17, -16, -15, -1, 0, 1, 15, 16, 17]) {
    const sq = square + offset;
    if (onBoard(sq)) zone.add(sq);
  }
  const attackingPieces = new Set<number>();
  for (const sq of zone) {
    for (const attacker of findAttackers(pos, sq, attackerColour)) attackingPieces.add(attacker);
  }

  const dir = colour === WHITE ? 1 : -1;
  const friendlyPawn = makePiece(colour, PAWN);
  let shield = 0;
  let openFiles = 0;
  for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1); f++) {
    let hasPawn = false;
    for (let step = 1; step <= 2; step++) {
      const sq = squareOf(f, rank + dir * step);
      if (!onBoard(sq)) break;
      if (board[sq] === friendlyPawn) {
        hasPawn = true;
        break;
      }
    }
    if (hasPawn) shield++;
    else if (f !== file) openFiles++;
  }

  let escapeSquares = 0;
  for (const offset of KING_OFFSETS) {
    const sq = square + offset;
    if (!onBoard(sq)) continue;
    const occupant = board[sq];
    if (occupant !== EMPTY && pieceColor(occupant) === colour) continue;
    if (!pos.isAttacked(sq, attackerColour)) escapeSquares++;
  }

  const castled =
    colour === WHITE ? /^[gcb]1$/.test(name) : /^[gcb]8$/.test(name);

  return {
    square: name,
    attackers: attackingPieces.size,
    shieldPawns: shield,
    openFilesBeside: openFiles,
    escapeSquares,
    exposure: describeKing(name, castled, attackingPieces.size, shield, openFiles, escapeSquares)
  };
}

/** Deterministic, human-readable facts about a position. */
export function analyzePosition(pos: Position, moves: string[] = []): PositionFacts {
  const board = pos.board;
  const us = pos.turn;
  const them = opponent(us);

  let whiteMaterial = 0;
  let blackMaterial = 0;
  let pieceCount = 0;
  let nonPawnMaterial = 0;

  for (let sq = 0; sq < 128; sq++) {
    const piece = board[sq];
    if (piece === EMPTY) continue;
    const type = pieceType(piece);
    pieceCount++;
    if (type !== KING && type !== PAWN) nonPawnMaterial += PIECE_VALUE[type];
    if (pieceColor(piece) === WHITE) whiteMaterial += PIECE_VALUE[type];
    else blackMaterial += PIECE_VALUE[type];
  }

  const signedDelta = Math.round((whiteMaterial - blackMaterial) / 100) * (us === WHITE ? 1 : -1);
  const materialLabel =
    signedDelta === 0
      ? 'Material is dead level'
      : `You are ${signedDelta > 0 ? 'up' : 'down'} ${Math.abs(signedDelta)} pawn(s) of material`;

  // Phase uses both the move counter and how much material is left, so a
  // mislabelled FEN cannot put the brain in the wrong mindset.
  let phase: GamePhase;
  const heavyPiecesLeft = nonPawnMaterial;
  if (heavyPiecesLeft <= 2 * (500 + 330 + 320)) phase = 'endgame';
  else if (pos.fullmove <= 8 && heavyPiecesLeft > START_NON_PAWN_MATERIAL * 0.8) phase = 'opening';
  else phase = 'middlegame';

  return {
    fen: pos.toFen(),
    sideToMove: us === WHITE ? 'w' : 'b',
    phase,
    fullmoveNumber: pos.fullmove,
    materialDeltaPawns: signedDelta,
    materialLabel,
    ourKing: kingFactsFor(pos, us, pos.kingSquare[us]),
    enemyKing: kingFactsFor(pos, them, pos.kingSquare[them]),
    passedPawns: collectPassedPawns(pos),
    hangingPieces: collectHangingPieces(pos),
    pieceCount,
    isInCheck: pos.inCheck(us),
    moveCount: moves.length
  };
}

function collectPassedPawns(pos: Position): PassedPawnFact[] {
  const board = pos.board;
  const whiteMinRank = new Int8Array(8).fill(99);
  const blackMaxRank = new Int8Array(8).fill(-1);
  const pawns: Array<{ square: number; colour: Color; rank: number; file: number }> = [];

  for (let sq = 0; sq < 128; sq++) {
    const piece = board[sq];
    if (piece === EMPTY || pieceType(piece) !== PAWN) continue;
    const file = fileOf(sq);
    const rank = rankOf(sq);
    const colour = pieceColor(piece);
    pawns.push({ square: sq, colour, rank, file });
    if (colour === WHITE) {
      if (rank < whiteMinRank[file]) whiteMinRank[file] = rank;
    } else if (rank > blackMaxRank[file]) {
      blackMaxRank[file] = rank;
    }
  }

  const passed: PassedPawnFact[] = [];
  for (const pawn of pawns) {
    let blocked = false;
    for (let f = Math.max(0, pawn.file - 1); f <= Math.min(7, pawn.file + 1); f++) {
      if (pawn.colour === WHITE) {
        if (blackMaxRank[f] > pawn.rank) blocked = true;
      } else if (whiteMinRank[f] < pawn.rank) {
        blocked = true;
      }
      if (blocked) break;
    }
    if (blocked) continue;
    passed.push({
      square: squareName(pawn.square),
      side: pawn.colour === WHITE ? 'w' : 'b',
      stepsToPromotion: pawn.colour === WHITE ? 7 - pawn.rank : pawn.rank
    });
  }

  return passed.sort((a, b) => a.stepsToPromotion - b.stepsToPromotion);
}

/**
 * Pieces of either colour that the opponent can win right now: undefended, or
 * attacked by something cheaper than themselves.
 */
function collectHangingPieces(pos: Position): HangingPieceFact[] {
  const result: HangingPieceFact[] = [];
  const board = pos.board;

  for (let sq = 0; sq < 128; sq++) {
    const piece = board[sq];
    if (piece === EMPTY) continue;
    const type = pieceType(piece);
    if (type === KING) continue;
    const colour = pieceColor(piece);
    const enemy = opponent(colour);
    if (!pos.isAttacked(sq, enemy)) continue;

    const attackers = findAttackers(pos, sq, enemy);
    if (attackers.length === 0) continue;

    const cheapestAttacker = Math.min(
      ...attackers.map((square) => PIECE_VALUE[pieceType(board[square])])
    );
    const value = PIECE_VALUE[type];
    const defended = pos.isAttacked(sq, colour);
    if (defended && cheapestAttacker >= value) continue;

    result.push({
      square: squareName(sq),
      piece: PIECE_NAME[PIECE_LETTER[piece].toLowerCase()] ?? 'piece',
      side: colour === WHITE ? 'w' : 'b',
      value,
      defended
    });
  }

  return result.sort((a, b) => b.value - a.value);
}

export { PIECE_NAME, findAttackers };