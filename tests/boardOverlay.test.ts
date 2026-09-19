import { describe, it, expect } from 'vitest';
import { BoardVisualOverlay } from '../src/content/boardOverlay';

describe('BoardVisualOverlay Coordinate Calculations', () => {
  const overlay = new BoardVisualOverlay();

  it('should calculate correct center coordinates for White perspective', () => {
    // a1 -> bottom-left in White orientation (file 1, rank 1 -> x=6.25, y=93.75)
    const a1 = overlay.squareToSvgCoords('a1', false);
    expect(a1.x).toBeCloseTo(6.25, 1);
    expect(a1.y).toBeCloseTo(93.75, 1);

    // e4 -> center (file 5, rank 4 -> x=56.25, y=56.25)
    const e4 = overlay.squareToSvgCoords('e4', false);
    expect(e4.x).toBeCloseTo(56.25, 1);
    expect(e4.y).toBeCloseTo(56.25, 1);

    // h8 -> top-right (file 8, rank 8 -> x=93.75, y=6.25)
    const h8 = overlay.squareToSvgCoords('h8', false);
    expect(h8.x).toBeCloseTo(93.75, 1);
    expect(h8.y).toBeCloseTo(6.25, 1);
  });

  it('should calculate inverted coordinates for Black (flipped) perspective', () => {
    // a1 in flipped board is top-right (x=93.75, y=6.25)
    const a1Flipped = overlay.squareToSvgCoords('a1', true);
    expect(a1Flipped.x).toBeCloseTo(93.75, 1);
    expect(a1Flipped.y).toBeCloseTo(6.25, 1);

    // h8 in flipped board is bottom-left (x=6.25, y=93.75)
    const h8Flipped = overlay.squareToSvgCoords('h8', true);
    expect(h8Flipped.x).toBeCloseTo(6.25, 1);
    expect(h8Flipped.y).toBeCloseTo(93.75, 1);
  });
});
