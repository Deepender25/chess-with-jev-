import { findChessBoardElement } from '../lib/domScanner';
import { findMoveListContainer } from '../lib/moveListParser';
import { BoardState } from '../types';
import { FENTracker } from '../lib/fenTracker';

export type StateChangeCallback = (state: BoardState) => void;

/**
 * Anything matched by this selector belongs to the extension, so mutations
 * inside it are never board changes. Without this the overlay arrow and the HUD
 * (which both write to the DOM on every update) re-trigger the observer, and the
 * extension ends up reacting to itself.
 */
const OWN_DOM_SELECTOR = '#jev-chess-hud, .jev-board-overlay-svg';

/** How long a position must stop changing before it is published. */
export const SETTLE_MS = 300;

/** Safety-net poll, in case a mutation is filtered out or missed. */
const TICK_MS = 1200;

function isOwnDom(node: Node | null): boolean {
  if (!node) return false;
  const el =
    node.nodeType === 1 ? (node as Element) : (node.parentElement as Element | null);
  return typeof el?.closest === 'function' && el.closest(OWN_DOM_SELECTOR) !== null;
}

/**
 * Watches the Chess.com board and move list, and reports a *settled* position.
 *
 * Three behaviours matter here, and all three were wrong before:
 *
 *  1. **No self-observation.** Mutations inside the extension's own HUD and
 *     overlay are ignored, so drawing an arrow cannot trigger a re-analysis.
 *  2. **Settling.** A position is published only once it has stopped changing
 *     for `SETTLE_MS`. When Chess.com re-renders the board (or the on-page move
 *     list is mid-swap), the intermediate readings are discarded rather than
 *     treated as new positions. If the reading flaps between two values, nothing
 *     is published at all until it stabilises.
 *  3. **Lifecycle.** The poll timer is owned and cleared by `stop()`, and a
 *     replaced board element is treated as a new game.
 */
export class ChessBoardObserver {
  private tracker: FENTracker;
  private observer: MutationObserver | null = null;
  private tickTimer: number | null = null;
  private settleTimer: number | null = null;
  private onStateChange: StateChangeCallback;

  private boardEl: HTMLElement | null = null;
  private moveListEl: HTMLElement | null = null;
  private lastBoardEl: HTMLElement | null = null;

  private lastFen = '';
  private lastGameOver = false;
  private pendingState: BoardState | null = null;
  private isRunning = false;

  constructor(onStateChange: StateChangeCallback) {
    this.tracker = new FENTracker();
    this.onStateChange = onStateChange;
  }

  public start(): void {
    this.stop();
    this.isRunning = true;

    this.resolveTargets();
    this.checkBoard();

    this.observer = new MutationObserver((mutations) => {
      if (this.hasRelevantMutation(mutations)) {
        this.scheduleCheck();
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      // `style` is deliberately absent: both Chess.com and this extension write
      // inline styles constantly, and none of it can change the position.
      attributeFilter: ['class', 'data-node', 'data-figurine']
    });

    this.tickTimer = window.setInterval(() => {
      this.checkBoard();
    }, TICK_MS);
  }

  public stop(): void {
    this.isRunning = false;

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.cancelSettle();

    this.boardEl = null;
    this.moveListEl = null;
    this.lastBoardEl = null;
    this.lastFen = '';
    this.lastGameOver = false;
  }

  /**
   * Re-resolves the board and move list on every check.
   *
   * Do not cache these across ticks. A cached element that is still attached but
   * no longer the live one — a move list the single-page app kept in the DOM but
   * emptied, for instance — silently returns nothing forever, and every read
   * then reports "no change" while the real game moves on. A handful of
   * `querySelectorAll` calls per check is a trivial price for never being stuck
   * on a dead element.
   */
  private resolveTargets(): void {
    const board = findChessBoardElement();
    if (board) this.boardEl = board;

    const list = findMoveListContainer();
    if (list) this.moveListEl = list;
  }

  /** Reads the board and hands the result to the settling gate. */
  public checkBoard(): void {
    this.resolveTargets();
    const boardEl = this.boardEl;
    if (!boardEl) return;

    // Chess.com swapped the board element out: a new game or a new view.
    if (this.lastBoardEl !== null && this.lastBoardEl !== boardEl) {
      this.tracker.reset();
      this.cancelSettle();
      this.pendingState = null;
      this.lastFen = '';
      this.lastGameOver = false;
    }
    this.lastBoardEl = boardEl;

    this.consider(this.tracker.extractCurrentState(boardEl, this.moveListEl));
  }

  public getCurrentState(): BoardState | null {
    return this.tracker.getLastKnownState();
  }

  /** How the current position was obtained, shown in the HUD. */
  public describeSource(): string {
    return this.tracker.describeSource();
  }

  /**
   * Coalescing debounce: a check that is already queued is *not* rescheduled.
   *
   * Resetting the timer on every mutation means continuous churn — the class
   * flicker on highlighted squares while a piece is dragged — can push the check
   * out forever. Letting the first mutation in a window win guarantees a check
   * lands within `SETTLE_MS` no matter how busy the page is.
   */
  private scheduleCheck(): void {
    if (this.settleTimer !== null) return;
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      this.checkBoard();
    }, SETTLE_MS);
  }

  private cancelSettle(): void {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  /**
   * Publishes a state only once it has stood still for `SETTLE_MS`.
   *
   * If a new reading arrives that matches what was last published, the pending
   * publication is dropped — that is a flap, and acting on it is exactly what
   * caused a suggestion to appear while the opponent was still thinking.
   */
  private consider(state: BoardState): void {
    const matchesPublished = state.fen === this.lastFen && state.isGameOver === this.lastGameOver;

    if (matchesPublished) {
      this.cancelSettle();
      this.pendingState = null;
      return;
    }

    // The very first position is published immediately so the HUD is not blank.
    if (this.lastFen === '' && this.pendingState === null) {
      this.publish(state);
      return;
    }

    if (
      this.pendingState &&
      this.pendingState.fen === state.fen &&
      this.pendingState.isGameOver === state.isGameOver
    ) {
      return; // already queued for exactly this state
    }

    this.pendingState = state;
    this.cancelSettle();
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      const pending = this.pendingState;
      this.pendingState = null;
      if (pending) this.publish(pending);
    }, SETTLE_MS);
  }

  private publish(state: BoardState): void {
    this.lastFen = state.fen;
    this.lastGameOver = state.isGameOver;
    this.onStateChange(state);
  }

  private hasRelevantMutation(mutations: MutationRecord[]): boolean {
    for (const mutation of mutations) {
      if (isOwnDom(mutation.target)) continue;

      if (mutation.type === 'childList') {
        const changed = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
        if (changed.length === 0) continue;
        // Text-only churn (clocks, counters, chat) cannot move a piece.
        if (changed.every((node) => node.nodeType === 3)) continue;
        if (changed.every((node) => isOwnDom(node))) continue;
        return true;
      }

      if (mutation.type === 'attributes') {
        const el = mutation.target as Element;
        const classes = el.classList;
        if (!classes) continue;
        const tag = el.tagName?.toLowerCase();
        if (
          classes.contains('piece') ||
          classes.contains('highlight') ||
          classes.contains('node') ||
          classes.contains('move-square') ||
          classes.contains('selected') ||
          tag === 'square' ||
          tag === 'chess-board' ||
          tag === 'wc-chess-board'
        ) {
          return true;
        }
      }
    }
    return false;
  }
}