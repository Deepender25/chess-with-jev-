import { PiecePlacement } from '../types';
import { parsePieceElement, parseSquareClass } from './coordinateMapper';

export interface DOMBoardScanResult {
  pieces: PiecePlacement[];
  piecePlacementFen: string; // e.g. "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R"
  isFlipped: boolean;
  highlightedSquares: string[];
  boardElement: HTMLElement | null;
}

/**
 * Finds the active main chessboard element on Chess.com, filtering out sidebar ads, mini-thumbnails, or promo boards.
 */
export function findChessBoardElement(root?: Document | HTMLElement): HTMLElement | null {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;

  // High priority: Main game layout containers
  const prioritizedSelectors = [
    '#board-layout-main wc-chess-board',
    '#board-layout-main chess-board',
    '#board-layout-chessboard wc-chess-board',
    '#board-layout-chessboard chess-board',
    '.board-layout-chessboard wc-chess-board',
    '.board-layout-chessboard chess-board',
    'div[id*="board-layout"] wc-chess-board',
    'div[id*="board-layout"] chess-board',
    '#board-single',
    'wc-chess-board.board',
    'chess-board.board',
    'wc-chess-board',
    'chess-board',
    '[data-test-element="chess-board"]'
  ];

  for (const selector of prioritizedSelectors) {
    const elements = doc.querySelectorAll(selector);
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as HTMLElement;

      // Filter out elements inside ad containers or sidebar promo widgets
      const isInsideAd = el.closest('.ad-unit, .ad-banner, .sidebar-ad, .sky-ad, .promo-card, [id*="ad-"]');
      if (isInsideAd) {
        continue;
      }

      // Check physical dimensions if available in browser
      if (typeof el.getBoundingClientRect === 'function') {
        const rect = el.getBoundingClientRect();
        // If element is rendered and has tiny thumbnail dimensions (< 220px), skip it
        if (rect.width > 0 && rect.width < 220) {
          continue;
        }
      }

      return el;
    }
  }

  return null;
}

/**
 * Scans the board DOM element to extract all current pieces and highlighted squares.
 * Ignores ghost pieces, dragging clones, fading animations, and hidden elements.
 */
export function scanDOMBoard(boardEl?: HTMLElement | null): DOMBoardScanResult {
  const el = boardEl || findChessBoardElement();
  if (!el) {
    return {
      pieces: [],
      piecePlacementFen: '',
      isFlipped: false,
      highlightedSquares: [],
      boardElement: null
    };
  }

  const isFlipped = el.classList.contains('flipped') || el.getAttribute('orientation') === 'black';

  // Find all piece elements, excluding animating ghosts and dragging clones
  const pieceNodes = el.querySelectorAll('.piece');
  const pieces: PiecePlacement[] = [];
  const squareMap = new Map<string, PiecePlacement>();

  pieceNodes.forEach((node) => {
    const htmlNode = node as HTMLElement;

    // Filter out dragging duplicates, ghosts, and invisible elements
    const className = htmlNode.className || '';
    if (
      className.includes('dragging') ||
      className.includes('ghost') ||
      className.includes('animating-out') ||
      className.includes('fading')
    ) {
      return;
    }

    if (htmlNode.style?.opacity === '0' || htmlNode.style?.display === 'none' || htmlNode.style?.visibility === 'hidden') {
      return;
    }

    const placement = parsePieceElement(className);
    if (placement) {
      squareMap.set(placement.square, placement);
    }
  });

  squareMap.forEach((piece) => {
    pieces.push(piece);
  });

  // Find highlighted squares
  const highlightNodes = el.querySelectorAll('.highlight');
  const highlightedSquares: string[] = [];
  highlightNodes.forEach((node) => {
    const parsed = parseSquareClass(node.className);
    if (parsed && !highlightedSquares.includes(parsed.square)) {
      highlightedSquares.push(parsed.square);
    }
  });

  // Build the 8x8 piece placement FEN string
  const fenRanks: string[] = [];

  for (let rank = 8; rank >= 1; rank--) {
    let emptyCount = 0;
    let rankStr = '';

    for (let file = 1; file <= 8; file++) {
      const fileChar = String.fromCharCode('a'.charCodeAt(0) + file - 1);
      const square = `${fileChar}${rank}`;
      const piece = squareMap.get(square);

      if (!piece) {
        emptyCount++;
      } else {
        if (emptyCount > 0) {
          rankStr += emptyCount.toString();
          emptyCount = 0;
        }
        const letter = piece.type;
        rankStr += piece.color === 'w' ? letter.toUpperCase() : letter.toLowerCase();
      }
    }

    if (emptyCount > 0) {
      rankStr += emptyCount.toString();
    }

    fenRanks.push(rankStr);
  }

  const piecePlacementFen = fenRanks.join('/');

  return {
    pieces,
    piecePlacementFen,
    isFlipped,
    highlightedSquares,
    boardElement: el
  };
}
