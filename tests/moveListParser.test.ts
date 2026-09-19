import { describe, it, expect } from 'vitest';
import { normalizeSan, parseMovesFromRawText } from '../src/lib/moveListParser';

describe('Move List Parser', () => {
  it('should normalize SAN moves with unicode figurines', () => {
    expect(normalizeSan('♘f3')).toBe('Nf3');
    expect(normalizeSan('♞c6')).toBe('Nc6');
    expect(normalizeSan('♗b5')).toBe('Bb5');
    expect(normalizeSan('♕xf7#')).toBe('Qxf7#');
    expect(normalizeSan('1. e4')).toBe('e4');
    expect(normalizeSan('12... O-O')).toBe('O-O');
  });

  it('should parse raw PGN / move text blocks', () => {
    const raw = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';
    const moves = parseMovesFromRawText(raw);
    expect(moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7']);
  });

  it('should handle castling, pawn promotions, and checks/checkmates in raw text', () => {
    const raw = '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
    const moves = parseMovesFromRawText(raw);
    expect(moves).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
  });
});
