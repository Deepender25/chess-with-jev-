import { Color, PiecePlacement, PieceType } from '../types';

const FILE_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

/**
 * Converts a 1-based file (1-8) and rank (1-8) to standard algebraic notation (e.g., 5, 2 -> 'e2').
 */
export function coordsToAlgebraic(file: number, rank: number): string {
  if (file < 1 || file > 8 || rank < 1 || rank > 8) {
    throw new Error(`Invalid board coordinates: file=${file}, rank=${rank}`);
  }
  return `${FILE_NAMES[file - 1]}${rank}`;
}

/**
 * Converts algebraic notation (e.g. 'e2') to 1-based file and rank (5, 2).
 */
export function algebraicToCoords(square: string): { file: number; rank: number } {
  if (!square || square.length !== 2) {
    throw new Error(`Invalid square notation: ${square}`);
  }
  const fileChar = square[0].toLowerCase();
  const rankChar = square[1];

  const file = FILE_NAMES.indexOf(fileChar as typeof FILE_NAMES[number]) + 1;
  const rank = parseInt(rankChar, 10);

  if (file < 1 || file > 8 || isNaN(rank) || rank < 1 || rank > 8) {
    throw new Error(`Invalid square notation: ${square}`);
  }

  return { file, rank };
}

/**
 * Parses square class string (e.g., 'square-52' or 'square-e4') into algebraic format ('e2' or 'e4').
 */
export function parseSquareClass(className: string): { square: string; file: number; rank: number } | null {
  const matchNumeric = className.match(/\bsquare-(\d)(\d)\b/);
  if (matchNumeric) {
    const file = parseInt(matchNumeric[1], 10);
    const rank = parseInt(matchNumeric[2], 10);
    if (file >= 1 && file <= 8 && rank >= 1 && rank <= 8) {
      return {
        square: coordsToAlgebraic(file, rank),
        file,
        rank
      };
    }
  }

  const matchAlgebraic = className.match(/\bsquare-([a-h])([1-8])\b/i);
  if (matchAlgebraic) {
    const fileChar = matchAlgebraic[1].toLowerCase();
    const rank = parseInt(matchAlgebraic[2], 10);
    const file = FILE_NAMES.indexOf(fileChar as typeof FILE_NAMES[number]) + 1;
    return {
      square: `${fileChar}${rank}`,
      file,
      rank
    };
  }

  return null;
}

/**
 * Parses piece class (e.g., 'wp', 'bn', 'wk') into piece type and color.
 */
export function parsePieceClass(className: string): { type: PieceType; color: Color } | null {
  const match = className.match(/\b([wb])([pnbrqk])\b/);
  if (!match) return null;

  const color = match[1] as Color;
  const type = match[2] as PieceType;

  return { type, color };
}

/**
 * Extracts piece placement from an element's class list.
 */
export function parsePieceElement(className: string): PiecePlacement | null {
  const squareInfo = parseSquareClass(className);
  const pieceInfo = parsePieceClass(className);

  if (!squareInfo || !pieceInfo) {
    return null;
  }

  return {
    type: pieceInfo.type,
    color: pieceInfo.color,
    square: squareInfo.square,
    file: squareInfo.file,
    rank: squareInfo.rank
  };
}
