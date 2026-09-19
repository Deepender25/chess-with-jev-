import { describe, it, expect } from 'vitest';
import {
  coordsToAlgebraic,
  algebraicToCoords,
  parseSquareClass,
  parsePieceClass,
  parsePieceElement
} from '../src/lib/coordinateMapper';

describe('Coordinate Mapper', () => {
  it('should convert coordinates to algebraic notation correctly', () => {
    expect(coordsToAlgebraic(1, 1)).toBe('a1');
    expect(coordsToAlgebraic(5, 2)).toBe('e2');
    expect(coordsToAlgebraic(5, 4)).toBe('e4');
    expect(coordsToAlgebraic(8, 8)).toBe('h8');
    expect(coordsToAlgebraic(3, 8)).toBe('c8');
  });

  it('should throw error for out of bounds coordinates', () => {
    expect(() => coordsToAlgebraic(0, 1)).toThrow();
    expect(() => coordsToAlgebraic(9, 4)).toThrow();
    expect(() => coordsToAlgebraic(4, 0)).toThrow();
    expect(() => coordsToAlgebraic(4, 9)).toThrow();
  });

  it('should convert algebraic notation to coordinates correctly', () => {
    expect(algebraicToCoords('a1')).toEqual({ file: 1, rank: 1 });
    expect(algebraicToCoords('e2')).toEqual({ file: 5, rank: 2 });
    expect(algebraicToCoords('e4')).toEqual({ file: 5, rank: 4 });
    expect(algebraicToCoords('h8')).toEqual({ file: 8, rank: 8 });
  });

  it('should parse Chess.com square-xy and square-e4 classes', () => {
    expect(parseSquareClass('piece wp square-52')).toEqual({
      square: 'e2',
      file: 5,
      rank: 2
    });
    expect(parseSquareClass('piece bn square-18')).toEqual({
      square: 'a8',
      file: 1,
      rank: 8
    });
    expect(parseSquareClass('highlight square-88')).toEqual({
      square: 'h8',
      file: 8,
      rank: 8
    });
    expect(parseSquareClass('piece wk square-e1')).toEqual({
      square: 'e1',
      file: 5,
      rank: 1
    });
  });

  it('should parse piece classes (color and piece type)', () => {
    expect(parsePieceClass('piece wp square-52')).toEqual({ color: 'w', type: 'p' });
    expect(parsePieceClass('piece bq square-48')).toEqual({ color: 'b', type: 'q' });
    expect(parsePieceClass('piece wn square-71')).toEqual({ color: 'w', type: 'n' });
    expect(parsePieceClass('piece bk square-58')).toEqual({ color: 'b', type: 'k' });
    expect(parsePieceClass('some-unrelated-class')).toBeNull();
  });

  it('should parse full piece element class string', () => {
    const placement = parsePieceElement('piece wr square-11');
    expect(placement).toEqual({
      type: 'r',
      color: 'w',
      square: 'a1',
      file: 1,
      rank: 1
    });
  });
});
