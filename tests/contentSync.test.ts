// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { BoardState } from '../src/types';

// content.ts self-initialises on import (chrome.runtime.sendMessage, DOM
// observers), so a minimal chrome stub must exist before it loads.
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    sendMessage: (_message: unknown, _callback?: (response: unknown) => void) => undefined,
    onMessage: { addListener: () => undefined },
    lastError: null
  },
  storage: {
    local: {
      get: (_keys: unknown, callback?: (items: unknown) => void) => callback?.({}),
      set: () => undefined,
      onChanged: { addListener: () => undefined }
    }
  }
};

const {
  detectBoardOrientation,
  orientationFromSignals,
  requestProgress,
  resetRequestMachineryForTest
} = await import('../src/content/content');

const FRESH: BoardState = {
  fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
  turn: 'b',
  turnDescription: 'Black to move',
  moveCount: 1,
  fullMoveNumber: 1,
  halfMoveClock: 0,
  castlingRights: 'KQkq',
  enPassantSquare: 'e3',
  moves: ['e4'],
  isCheck: false,
  isCheckmate: false,
  isDraw: false,
  isGameOver: false,
  timestamp: Date.now(),
  sources: 'move-list',
  isComplete: true,
  orientation: 'w'
};

function element(html: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild as HTMLElement;
}

describe('orientation detection', () => {
  it('reads the flip class off the board element itself', () => {
    expect(detectBoardOrientation(element('<wc-chess-board class="board flipped"></wc-chess-board>'))).toBe('b');
  });

  it('reads the flip class off a wrapper a few levels up', () => {
    const board = element('<wc-chess-board class="board"></wc-chess-board>');
    const inner = element('<div class="squares"></div>');
    board.appendChild(inner);
    const deep = element('<span></span>');
    inner.appendChild(deep);
    expect(detectBoardOrientation(board)).toBe('w');

    const flipped = element('<div class="flipped"><section><article></article></section></div>');
    const article = flipped.querySelector('article') as HTMLElement;
    article.appendChild(board);
    expect(detectBoardOrientation(board)).toBe('b');
  });

  it('reads the orientation attribute on the board or its ancestors', () => {
    expect(detectBoardOrientation(element('<wc-chess-board orientation="black"></wc-chess-board>'))).toBe(
      'b'
    );
    expect(detectBoardOrientation(element('<wc-chess-board orientation="white"></wc-chess-board>'))).toBe(
      'w'
    );
    const board = element('<wc-chess-board></wc-chess-board>');
    const host = element('<div orientation="black"></div>');
    host.appendChild(board);
    expect(detectBoardOrientation(board)).toBe('b');
  });

  it('finds the class on the inner square grid as a last resort', () => {
    const board = element('<wc-chess-board></wc-chess-board>');
    board.appendChild(element('<div class="squares flipped"></div>'));
    expect(detectBoardOrientation(board)).toBe('b');
  });

  it('returns null with no board, so callers cannot guess', () => {
    expect(detectBoardOrientation(null)).toBeNull();
  });
});

describe('orientation priority', () => {
  it('prefers the flip marker over the attribute', () => {
    expect(orientationFromSignals({ flipped: true, orientation: 'white' }, element('<div></div>'))).toBe(
      'b'
    );
  });

  it('uses the attribute when no flip marker is present', () => {
    expect(
      orientationFromSignals({ flipped: false, orientation: 'black' }, element('<div></div>'))
    ).toBe('b');
    expect(
      orientationFromSignals({ flipped: false, orientation: 'white' }, element('<div></div>'))
    ).toBe('w');
  });

  it('falls back to the default side only when a board element exists', () => {
    expect(orientationFromSignals({ flipped: false, orientation: null }, element('<div></div>'))).toBe(
      'w'
    );
    expect(orientationFromSignals({ flipped: false, orientation: null }, null)).toBeNull();
  });
});

describe('request machinery reset', () => {
  it('reports a clean snapshot after a reset', () => {
    resetRequestMachineryForTest();
    const snapshot = JSON.parse(requestProgress());
    expect(snapshot.pendingFen).toBeNull();
    expect(snapshot.displayedFen).toBeNull();
    expect(snapshot.abandonedFen).toBeNull();
  });

  it('derives fresh state fixtures from the starting position', () => {
    const chess = new Chess();
    chess.move('e4');
    expect(FRESH.moves).toEqual(['e4']);
    expect(chess.turn()).toBe(FRESH.turn);
  });
});