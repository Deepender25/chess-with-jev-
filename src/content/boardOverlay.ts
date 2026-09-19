import { algebraicToCoords } from '../lib/coordinateMapper';
import { findChessBoardElement } from '../lib/domScanner';

export class BoardVisualOverlay {
  private overlaySvg: SVGSVGElement | null = null;
  private isEnabled = true;
  private currentMove: { from: string; to: string } | null = null;

  constructor() {
    if (typeof document !== 'undefined') {
      this.ensureOverlayExists();
    }
  }

  /**
   * Ensures the SVG overlay element is attached to the active chessboard container.
   */
  public ensureOverlayExists(): SVGSVGElement | null {
    if (typeof document === 'undefined') return null;

    const boardEl = findChessBoardElement();
    if (!boardEl) {
      this.overlaySvg?.remove();
      this.overlaySvg = null;
      return null;
    }

    if (this.overlaySvg && this.overlaySvg.parentElement === boardEl) {
      return this.overlaySvg;
    }

    // Ensure parent has relative positioning
    const computedStyle = window.getComputedStyle(boardEl);
    if (computedStyle.position === 'static') {
      boardEl.style.position = 'relative';
    }

    // Create SVG overlay
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'jev-board-overlay-svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');

    // Add gradient definitions
    svg.innerHTML = `
      <defs>
        <linearGradient id="jev-arrow-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ffffff" />
          <stop offset="100%" stop-color="#10b981" />
        </linearGradient>
      </defs>
      <g id="jev-squares-layer"></g>
      <g id="jev-arrows-layer"></g>
    `;

    boardEl.appendChild(svg);
    this.overlaySvg = svg;

    return svg;
  }

  /**
   * Converts algebraic square (e.g. 'e2') to SVG coordinate percentages (0 to 100).
   */
  public squareToSvgCoords(square: string, isFlipped: boolean): { x: number; y: number; squareSize: number } {
    const { file, rank } = algebraicToCoords(square);
    const squareSize = 100 / 8; // 12.5%

    // If White is at bottom:
    // File a=1 -> x=0, File h=8 -> x=7
    // Rank 8 -> y=0, Rank 1 -> y=7
    let fileIdx = file - 1;
    let rankIdx = 8 - rank;

    if (isFlipped) {
      fileIdx = 8 - file;
      rankIdx = rank - 1;
    }

    const x = fileIdx * squareSize + squareSize / 2;
    const y = rankIdx * squareSize + squareSize / 2;

    return { x, y, squareSize };
  }

  /**
   * Draws visual neon arrow and square highlights for the recommended move.
   */
  public drawMove(from: string, to: string): void {
    this.currentMove = { from, to };
    if (!this.isEnabled || typeof document === 'undefined') return;

    const svg = this.ensureOverlayExists();
    const boardEl = findChessBoardElement();
    if (!svg || !boardEl) return;

    const isFlipped = boardEl.classList.contains('flipped') || boardEl.getAttribute('orientation') === 'black';

    const fromCoords = this.squareToSvgCoords(from, isFlipped);
    const toCoords = this.squareToSvgCoords(to, isFlipped);
    const sqSize = fromCoords.squareSize;

    const squaresLayer = svg.querySelector('#jev-squares-layer');
    const arrowsLayer = svg.querySelector('#jev-arrows-layer');

    if (!squaresLayer || !arrowsLayer) return;

    // 1. Draw source and target square highlight boxes
    const fromBoxX = fromCoords.x - sqSize / 2;
    const fromBoxY = fromCoords.y - sqSize / 2;
    const toBoxX = toCoords.x - sqSize / 2;
    const toBoxY = toCoords.y - sqSize / 2;

    squaresLayer.innerHTML = `
      <rect class="jev-square-source" x="${fromBoxX + 0.5}" y="${fromBoxY + 0.5}" width="${sqSize - 1}" height="${sqSize - 1}" />
      <rect class="jev-square-target" x="${toBoxX + 0.5}" y="${toBoxY + 0.5}" width="${sqSize - 1}" height="${sqSize - 1}" />
    `;

    // 2. Draw Arrow Line
    const dx = toCoords.x - fromCoords.x;
    const dy = toCoords.y - fromCoords.y;
    const distance = Math.hypot(dx, dy);

    if (distance === 0) return;

    // Arrow tip offset (so head stops right at the boundary of target square)
    const headLength = 3.2;
    const endX = toCoords.x - (dx / distance) * 1.2;
    const endY = toCoords.y - (dy / distance) * 1.2;

    // Arrowhead polygon vertices
    const angle = Math.atan2(dy, dx);

    const p1X = toCoords.x;
    const p1Y = toCoords.y;
    const p2X = toCoords.x - headLength * Math.cos(angle - Math.PI / 7);
    const p2Y = toCoords.y - headLength * Math.sin(angle - Math.PI / 7);
    const p3X = toCoords.x - headLength * Math.cos(angle + Math.PI / 7);
    const p3Y = toCoords.y - headLength * Math.sin(angle + Math.PI / 7);

    arrowsLayer.innerHTML = `
      <line class="jev-arrow-line" x1="${fromCoords.x}" y1="${fromCoords.y}" x2="${endX}" y2="${endY}" />
      <polygon class="jev-arrow-head" points="${p1X},${p1Y} ${p2X},${p2Y} ${p3X},${p3Y}" />
    `;
  }

  /**
   * Clears the current arrow and highlights.
   */
  public clear(): void {
    this.currentMove = null;
    const svg = this.overlaySvg;
    if (svg) {
      const squaresLayer = svg.querySelector('#jev-squares-layer');
      const arrowsLayer = svg.querySelector('#jev-arrows-layer');
      if (squaresLayer) squaresLayer.innerHTML = '';
      if (arrowsLayer) arrowsLayer.innerHTML = '';
    }
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    if (!enabled) {
      this.clear();
    } else if (this.currentMove) {
      this.drawMove(this.currentMove.from, this.currentMove.to);
    }
  }

  public redraw(): void {
    if (this.currentMove && this.isEnabled) {
      this.drawMove(this.currentMove.from, this.currentMove.to);
    }
  }
}
