/**
 * Maps figurine Unicode and icon class names to standard SAN piece letters (N, B, R, Q, K).
 */
const FIGURINE_MAP: Record<string, string> = {
  '♔': 'K', '♚': 'K',
  '♕': 'Q', '♛': 'Q',
  '♖': 'R', '♜': 'R',
  '♗': 'B', '♝': 'B',
  '♘': 'N', '♞': 'N',
};

/**
 * Normalizes move text by converting unicode figurines and removing extraneous glyphs.
 */
export function normalizeSan(rawText: string): string {
  let text = rawText.trim();

  // Replace Unicode chess symbols
  for (const [symbol, letter] of Object.entries(FIGURINE_MAP)) {
    text = text.replaceAll(symbol, letter);
  }

  // Remove move numbers like "1.", "12...", or evaluation badges/time annotations
  text = text.replace(/^\d+\.+/, '').trim();
  text = text.replace(/\s*\{[^}]*\}\s*/g, ''); // Remove PGN comments {[%clk 0:02:59]}
  text = text.replace(/\s*\(\s*\)\s*/g, '');

  // Strip non-standard whitespace
  text = text.replace(/\s+/g, '');

  return text;
}

/**
 * Finds the move list container on Chess.com
 */
export function findMoveListContainer(root: Document | HTMLElement = document): HTMLElement | null {
  const selectors = [
    '#board-layout-sidebar wc-vertical-move-list',
    '#board-layout-sidebar .move-list',
    '#board-layout-sidebar .vertical-move-list',
    '#board-layout-sidebar .play-controller-move-list',
    'wc-vertical-move-list',
    'wc-move-list',
    '.move-list',
    '.vertical-move-list',
    '.game-move-list',
    '.play-controller-move-list',
    'div[class*="move-list"]',
    '[data-test-element="move-list"]'
  ];

  for (const selector of selectors) {
    const el = root.querySelector(selector) as HTMLElement | null;
    if (el) return el;
  }

  return null;
}

/**
 * Extracts the full list of played moves in chronological SAN order from Chess.com DOM.
 */
export function parseMoveList(container?: HTMLElement | null): string[] {
  const el = container || findMoveListContainer();
  if (!el) return [];

  // Strategy 1: Select individual move nodes
  const nodeSelectors = [
    '.node:not(.move-list-placeholder):not(.label):not([class*="evaluation"])',
    '.move-text-component',
    '[data-whole-move-number] .white:not(.label), [data-whole-move-number] .black:not(.label)',
    '.move-row .white-move, .move-row .black-move'
  ];

  for (const selector of nodeSelectors) {
    const nodes = el.querySelectorAll(selector);
    if (nodes && nodes.length > 0) {
      const moves: string[] = [];
      nodes.forEach((node) => {
        // Extract figurine if present as data attribute
        let text = '';
        const figurine = node.getAttribute('data-figurine') || node.querySelector('[data-figurine]')?.getAttribute('data-figurine');
        if (figurine) {
          text = figurine + (node.textContent || '');
        } else {
          // Check child icon classes (e.g. icon-font-chess knight-white)
          const iconEl = node.querySelector('[class*="icon-font-chess"], [class*="chess-glyph"]');
          if (iconEl) {
            const iconClass = iconEl.className;
            let piecePrefix = '';
            if (iconClass.includes('knight')) piecePrefix = 'N';
            else if (iconClass.includes('bishop')) piecePrefix = 'B';
            else if (iconClass.includes('rook')) piecePrefix = 'R';
            else if (iconClass.includes('queen')) piecePrefix = 'Q';
            else if (iconClass.includes('king')) piecePrefix = 'K';

            // Clone node without icon to get the rest of text
            const clone = node.cloneNode(true) as HTMLElement;
            clone.querySelector('[class*="icon-font-chess"], [class*="chess-glyph"]')?.remove();
            text = piecePrefix + (clone.textContent || '');
          } else {
            text = node.textContent || '';
          }
        }

        const clean = normalizeSan(text);
        if (clean && clean.length >= 2 && !clean.match(/^\d+$/)) {
          moves.push(clean);
        }
      });

      if (moves.length > 0) {
        return moves;
      }
    }
  }

  // Strategy 2: Raw text parsing fallback
  const rawText = el.innerText || el.textContent || '';
  return parseMovesFromRawText(rawText);
}

/**
 * Fallback parser that extracts SAN moves from plain text blocks (e.g., "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6")
 */
export function parseMovesFromRawText(text: string): string[] {
  if (!text) return [];

  const moves: string[] = [];
  // Tokenize words
  const tokens = text.split(/\s+/);

  for (let i = 0; i < tokens.length; i++) {
    const token = normalizeSan(tokens[i]);
    // Skip move numbers like "1.", "2...", evaluation scores "+0.5", or result markers like "1-0", "0-1", "1/2-1/2", "*"
    if (
      !token ||
      token.match(/^\d+\.*$/) ||
      token.match(/^[+-]?\d+(\.\d+)?$/) ||
      token.match(/^(1-0|0-1|1\/2-1\/2|\*)$/)
    ) {
      continue;
    }

    // Check if token looks like standard chess move notation
    if (token.match(/^([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQ])?|O-O(-O)?)[+#]?$/)) {
      moves.push(token);
    }
  }

  return moves;
}
