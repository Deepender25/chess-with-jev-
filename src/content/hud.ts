import { BoardState, Color, JevRecommendationState } from '../types';
import { BoardVisualOverlay } from './boardOverlay';

export type PlayerColorChangeCallback = (color: Color) => void;

export class InPageHUD {
  private hudElement: HTMLElement | null = null;
  private visualOverlay: BoardVisualOverlay;
  private isMinimized = false;
  private isDragging = false;
  private isOverlayEnabled = true;
  private playerColor: Color = 'w';
  private onColorChange?: PlayerColorChangeCallback;
  private dragOffset = { x: 0, y: 0 };
  private latestState: BoardState | null = null;
  private latestRecommendation: JevRecommendationState | null = null;

  constructor(onColorChange?: PlayerColorChangeCallback) {
    this.onColorChange = onColorChange;
    this.visualOverlay = new BoardVisualOverlay();
    this.createHUD();
  }

  public setPlayerColor(color: Color): void {
    this.playerColor = color;
    const colorBtn = this.hudElement?.querySelector('#jev-player-color-btn');
    if (colorBtn) {
      colorBtn.textContent = color === 'w' ? 'WHITE' : 'BLACK';
    }
  }

  /**
   * Injects the HUD container into the document.
   */
  public createHUD(): void {
    if (document.getElementById('jev-chess-hud')) {
      this.hudElement = document.getElementById('jev-chess-hud');
      return;
    }

    const hud = document.createElement('div');
    hud.id = 'jev-chess-hud';
    hud.innerHTML = `
      <div class="jev-hud-header" id="jev-hud-drag-handle">
        <div class="jev-brand">
          <span class="jev-logo-badge">JEV</span>
          <span class="jev-brand-name">CHESS</span>
        </div>
        <div class="jev-hud-actions">
          <button class="jev-btn-icon active" id="jev-hud-arrow-btn" title="Toggle Move Arrow">ARROW</button>
          <button class="jev-btn-icon" id="jev-player-color-btn" title="Toggle Color (White / Black)">WHITE</button>
          <span class="jev-status-dot-badge" id="jev-server-pill" title="Engine Online">
            <span class="jev-status-dot"></span>
          </span>
          <button class="jev-btn-icon min-btn" id="jev-hud-minimize-btn" title="Minimize / Expand">—</button>
        </div>
      </div>

      <div class="jev-hud-body">
        <!-- Turn & Move Counter -->
        <div class="jev-turn-row">
          <div class="jev-turn-badge" id="jev-turn-badge">
            <span class="turn-dot-indicator" id="jev-turn-dot"></span>
            <span id="jev-turn-text">White to move</span>
          </div>
          <div class="jev-move-counter" id="jev-move-counter">Move #1</div>
        </div>

        <!-- Jev Recommendation Card -->
        <div class="jev-recommendation-card" id="jev-rec-container">
          <div class="jev-rec-header">
            <span>DECISION ENGINE</span>
            <span class="jev-latency-badge" id="jev-rec-latency">Ready</span>
          </div>
          
          <div class="jev-rec-main-row" id="jev-rec-main-row">
            <div class="jev-rec-move-large" id="jev-rec-move">...</div>
            <div class="jev-confidence-pill" id="jev-confidence-pill" style="display: none;">--%</div>
          </div>

          <!-- Promotion / Passed Pawn Alert Banner -->
          <div class="jev-promotion-banner" id="jev-promo-banner" style="display: none;">
            <span class="banner-tag">PASSED PAWN</span>
            <span id="jev-promo-banner-text">Advancing to promotion square</span>
          </div>

          <!-- Threat / Danger Radar Banner -->
          <div class="jev-threat-banner" id="jev-threat-banner" style="display: none;">
            <span class="banner-tag">THREAT</span>
            <span id="jev-threat-banner-text">Danger</span>
          </div>

          <!-- Strategic Rationale Box -->
          <div class="jev-rationale-box" id="jev-rationale-box" style="display: none;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
              <strong id="jev-priority-badge" class="jev-priority-badge">KING HUNT</strong>
              <span id="jev-king-exposure-badge" style="font-size: 10px; color: #888888;"></span>
            </div>
            <div><strong>PLAN:</strong> <span id="jev-rationale-text">...</span></div>
          </div>

          <!-- Top Candidates Progress Bars -->
          <div class="jev-candidates-section" id="jev-candidates-section" style="display: none;"></div>

          <div class="jev-rec-tags" id="jev-rec-tags" style="display: none;">
            <span class="jev-tag" id="jev-eval-tag">Balanced</span>
            <span class="jev-tag material" id="jev-material-tag" style="display: none;">+0</span>
            <span class="jev-tag" id="jev-theme-tag">Development</span>
            <span class="jev-tag priority" id="jev-priority-tag" style="display: none;">King Hunt</span>
            <span class="jev-tag promotion" id="jev-promo-tag" style="display: none;">Passed Pawn</span>
            <span class="jev-tag danger" id="jev-danger-tag" style="display: none;">Tactical Danger</span>
            <span class="jev-tag mate" id="jev-mate-tag" style="display: none;">Checkmate Threat</span>
          </div>
        </div>

        <!-- FEN Box -->
        <div class="jev-fen-section">
          <div class="jev-section-label">
            <span>Verified FEN</span>
            <span id="jev-check-status" style="color: #ef4444; font-weight: bold; display: none;">CHECK</span>
          </div>
          <div class="jev-fen-box">
            <span class="jev-fen-text" id="jev-fen-display" title="Click Copy to copy full FEN">rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1</span>
            <button class="jev-copy-btn" id="jev-copy-fen-btn">Copy</button>
          </div>
        </div>

        <div class="jev-footer">
          <span>TypeSafe AI • System One</span>
          <span id="jev-mode-label" style="color: #ffffff;">Live</span>
        </div>
      </div>
    `;

    document.body.appendChild(hud);
    this.hudElement = hud;

    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    if (!this.hudElement) return;

    // Minimize toggle
    const minBtn = this.hudElement.querySelector('#jev-hud-minimize-btn');
    minBtn?.addEventListener('click', () => {
      this.toggleMinimize();
    });

    // Player color toggle button
    const colorBtn = this.hudElement.querySelector('#jev-player-color-btn');
    colorBtn?.addEventListener('click', () => {
      this.playerColor = this.playerColor === 'w' ? 'b' : 'w';
      this.setPlayerColor(this.playerColor);
      if (this.onColorChange) {
        this.onColorChange(this.playerColor);
      }
    });

    // Arrow overlay toggle
    const arrowBtn = this.hudElement.querySelector('#jev-hud-arrow-btn') as HTMLElement | null;
    arrowBtn?.addEventListener('click', () => {
      this.isOverlayEnabled = !this.isOverlayEnabled;
      this.visualOverlay.setEnabled(this.isOverlayEnabled);
      arrowBtn.classList.toggle('active', this.isOverlayEnabled);
    });

    // Copy FEN button
    const copyBtn = this.hudElement.querySelector('#jev-copy-fen-btn') as HTMLButtonElement | null;
    copyBtn?.addEventListener('click', () => {
      if (this.latestState?.fen) {
        navigator.clipboard.writeText(this.latestState.fen).then(() => {
          if (copyBtn) {
            copyBtn.textContent = 'COPIED';
            copyBtn.classList.add('copied');
            setTimeout(() => {
              copyBtn.textContent = 'Copy';
              copyBtn.classList.remove('copied');
            }, 2000);
          }
        });
      }
    });

    // Draggable header
    const header = this.hudElement.querySelector('#jev-hud-drag-handle') as HTMLElement | null;
    header?.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName.toLowerCase() === 'button') return;
      this.isDragging = true;
      const rect = this.hudElement!.getBoundingClientRect();
      this.dragOffset.x = e.clientX - rect.left;
      this.dragOffset.y = e.clientY - rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isDragging || !this.hudElement) return;
      const x = Math.max(10, Math.min(window.innerWidth - this.hudElement.offsetWidth - 10, e.clientX - this.dragOffset.x));
      const y = Math.max(10, Math.min(window.innerHeight - this.hudElement.offsetHeight - 10, e.clientY - this.dragOffset.y));
      this.hudElement.style.left = `${x}px`;
      this.hudElement.style.top = `${y}px`;
      this.hudElement.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    window.addEventListener('resize', () => {
      this.visualOverlay.redraw();
    });
  }

  /** The exact recommendation currently rendered, for popups and tests. */
  public getLatestRecommendation(): JevRecommendationState | null {
    return this.latestRecommendation;
  }

  public setServerStatus(connected: boolean): void {
    if (!this.hudElement) return;
    const pill = this.hudElement.querySelector('#jev-server-pill');
    if (pill) {
      pill.classList.toggle('offline', !connected);
      pill.setAttribute('title', connected ? 'Jev Engine Online' : 'Connecting...');
    }
  }

  public updateBoardState(state: BoardState): void {
    this.latestState = state;
    if (!this.hudElement) return;

    // Turn indicator
    const turnDot = this.hudElement.querySelector('#jev-turn-dot');
    const turnText = this.hudElement.querySelector('#jev-turn-text');
    const moveCounter = this.hudElement.querySelector('#jev-move-counter');
    const fenDisplay = this.hudElement.querySelector('#jev-fen-display');
    const checkStatus = this.hudElement.querySelector('#jev-check-status') as HTMLElement | null;

    if (turnDot) {
      turnDot.className = `turn-dot-indicator ${state.turn === 'w' ? 'white' : 'black'}`;
    }
    if (turnText) turnText.textContent = state.turn === 'w' ? 'White to move' : 'Black to move';
    if (moveCounter) {
      const moveLabel = state.lastMove?.san ? `Last: ${state.lastMove.san} | ` : '';
      moveCounter.textContent = `${moveLabel}Move #${state.fullMoveNumber}`;
    }
    if (fenDisplay) {
      fenDisplay.textContent = state.fen;
      fenDisplay.setAttribute('title', state.fen);
    }
    if (checkStatus) {
      if (state.isCheckmate) {
        checkStatus.textContent = 'CHECKMATE';
        checkStatus.style.display = 'inline';
      } else if (state.isCheck) {
        checkStatus.textContent = 'CHECK';
        checkStatus.style.display = 'inline';
      } else if (state.isDraw) {
        checkStatus.textContent = 'DRAW';
        checkStatus.style.display = 'inline';
      } else {
        checkStatus.style.display = 'none';
      }
    }
  }

  public updateRecommendation(rec: JevRecommendationState): void {
    this.latestRecommendation = rec;
    if (!this.hudElement) return;

    const recMove = this.hudElement.querySelector('#jev-rec-move');
    const recLatency = this.hudElement.querySelector('#jev-rec-latency');
    const confPill = this.hudElement.querySelector('#jev-confidence-pill') as HTMLElement | null;
    const rationaleBox = this.hudElement.querySelector('#jev-rationale-box') as HTMLElement | null;
    const rationaleText = this.hudElement.querySelector('#jev-rationale-text');
    const candidatesSection = this.hudElement.querySelector('#jev-candidates-section') as HTMLElement | null;
    const tagsContainer = this.hudElement.querySelector('#jev-rec-tags') as HTMLElement | null;
    const evalTag = this.hudElement.querySelector('#jev-eval-tag');
    const materialTag = this.hudElement.querySelector('#jev-material-tag') as HTMLElement | null;
    const themeTag = this.hudElement.querySelector('#jev-theme-tag');
    const promoTag = this.hudElement.querySelector('#jev-promo-tag') as HTMLElement | null;
    const dangerTag = this.hudElement.querySelector('#jev-danger-tag') as HTMLElement | null;
    const mateTag = this.hudElement.querySelector('#jev-mate-tag') as HTMLElement | null;
    const promoBanner = this.hudElement.querySelector('#jev-promo-banner') as HTMLElement | null;
    const promoBannerText = this.hudElement.querySelector('#jev-promo-banner-text');
    const threatBanner = this.hudElement.querySelector('#jev-threat-banner') as HTMLElement | null;
    const threatBannerText = this.hudElement.querySelector('#jev-threat-banner-text');
    const priorityBadge = this.hudElement.querySelector('#jev-priority-badge') as HTMLElement | null;
    const kingExposureBadge = this.hudElement.querySelector('#jev-king-exposure-badge') as HTMLElement | null;
    const priorityTag = this.hudElement.querySelector('#jev-priority-tag') as HTMLElement | null;
    const modeLabel = this.hudElement.querySelector('#jev-mode-label');

    if (rec.status === 'idle') {
      if (recMove) {
        const message = rec.errorMessage ?? "Opponent's turn...";
        recMove.innerHTML = `<span style="font-size: 13px; color: #888888; font-weight: normal;">${message}</span>`;
      }
      if (recLatency) recLatency.textContent = 'Waiting';
      if (confPill) confPill.style.display = 'none';
      if (rationaleBox) rationaleBox.style.display = 'none';
      if (candidatesSection) candidatesSection.style.display = 'none';
      if (tagsContainer) tagsContainer.style.display = 'none';
      if (promoBanner) promoBanner.style.display = 'none';
      if (threatBanner) threatBanner.style.display = 'none';
      this.visualOverlay.clear();
      return;
    }

    if (rec.status === 'analyzing') {
      if (recMove) recMove.innerHTML = '<span style="font-size: 13px; color: #cccccc;">Analyzing position...</span>';
      if (recLatency) recLatency.textContent = 'Thinking';
      if (confPill) confPill.style.display = 'none';
      if (rationaleBox) rationaleBox.style.display = 'none';
      if (candidatesSection) candidatesSection.style.display = 'none';
      if (tagsContainer) tagsContainer.style.display = 'none';
      if (promoBanner) promoBanner.style.display = 'none';
      if (threatBanner) threatBanner.style.display = 'none';
      this.visualOverlay.clear();
      return;
    }

    if (rec.status === 'ready' && rec.recommendedMove) {
      const formatted = this.formatMoveDisplay(rec.recommendedMove, rec.fromSquare, rec.toSquare);
      if (recMove) {
        recMove.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <div style="font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; font-family: monospace;">
              ${formatted.main}
            </div>
            <div style="font-size: 11px; color: #888888; font-weight: 500;">
              ${formatted.details}
            </div>
          </div>
        `;
      }

      if (rec.confidence && confPill) {
        confPill.textContent = `${Math.round(rec.confidence * 100)}%`;
        confPill.style.display = 'inline-block';
      }

      if (rec.latencyMs !== undefined && recLatency) {
        recLatency.textContent = `${rec.latencyMs}ms`;
      }

      // Draw in-board visual arrow
      if (rec.fromSquare && rec.toSquare) {
        this.visualOverlay.drawMove(rec.fromSquare, rec.toSquare);
      }

      // Promotion Alert Banner
      if (rec.promotionAlert && promoBanner && promoBannerText) {
        promoBannerText.textContent = rec.promotionAlert;
        promoBanner.style.display = 'flex';
      } else if (promoBanner) {
        promoBanner.style.display = 'none';
      }

      // Threat Alert Banner
      if (rec.threatAlert && threatBanner && threatBannerText) {
        threatBannerText.textContent = rec.threatAlert;
        threatBanner.style.display = 'flex';
      } else if (threatBanner) {
        threatBanner.style.display = 'none';
      }

      // Rationale Box & Strategic Priority
      if (rationaleBox) {
        if (priorityBadge && rec.strategicPriority) {
          const formattedPrio = rec.strategicPriority.replace(/_/g, ' ').toUpperCase();
          priorityBadge.textContent = formattedPrio;
        }

        if (kingExposureBadge && rec.enemyKingExposure) {
          kingExposureBadge.textContent = rec.enemyKingExposure.includes('CRITICALLY EXPOSED') ? 'ENEMY KING EXPOSED' : '';
        }

        if (rec.strategicRationale && rationaleText) {
          rationaleText.textContent = rec.strategicRationale;
        }

        rationaleBox.style.display = 'block';
      }

      // Candidates Progress Bars
      if (rec.topCandidates && rec.topCandidates.length > 0 && candidatesSection) {
        candidatesSection.innerHTML = rec.topCandidates.map((c) => {
          const candFmt = this.formatMoveDisplay(c.move, c.from, c.to, c.piece, c.captured);
          return `
            <div class="jev-candidate-row" title="${candFmt.details}">
              <span class="jev-candidate-name">${candFmt.main}</span>
              <div class="jev-candidate-bar-bg">
                <div class="jev-candidate-bar-fill" style="width: ${Math.round(c.probability * 100)}%;"></div>
              </div>
              <span class="jev-candidate-prob">${Math.round(c.probability * 100)}%</span>
            </div>
          `;
        }).join('');
        candidatesSection.style.display = 'flex';
      }

      if (tagsContainer) {
        tagsContainer.style.display = 'flex';
      }

      if (evalTag && rec.positionEvaluationLabel) {
        evalTag.textContent = `Eval: ${rec.positionEvaluationLabel}`;
      }

      if (materialTag) {
        if (rec.materialDelta !== undefined && rec.materialDelta !== 0) {
          materialTag.textContent = `Material: ${rec.materialDelta > 0 ? '+' : ''}${rec.materialDelta}`;
          materialTag.style.display = 'inline-block';
        } else {
          materialTag.style.display = 'none';
        }
      }

      if (themeTag && rec.strategicTheme) {
        themeTag.textContent = `Theme: ${rec.strategicTheme.replace(/_/g, ' ').toUpperCase()}`;
      }

      if (priorityTag && rec.strategicPriority) {
        priorityTag.textContent = `Plan: ${rec.strategicPriority.replace(/_/g, ' ').toUpperCase()}`;
        priorityTag.style.display = 'inline-block';
      }

      if (promoTag) {
        promoTag.style.display = rec.promotionAlert ? 'inline-block' : 'none';
      }

      if (dangerTag) {
        dangerTag.style.display = rec.isTacticalDanger ? 'inline-block' : 'none';
      }

      if (mateTag) {
        mateTag.style.display = rec.isCheckmateOpportunity ? 'inline-block' : 'none';
      }

      if (modeLabel) {
        modeLabel.textContent = rec.isSimulated ? 'Engine Search' : 'Jev System 1';
      }
    } else if (rec.status === 'error') {
      if (recMove) recMove.textContent = 'Error';
      if (recLatency) recLatency.textContent = 'Offline';
      if (confPill) confPill.style.display = 'none';
      if (rationaleBox) rationaleBox.style.display = 'none';
      if (candidatesSection) candidatesSection.style.display = 'none';
      if (tagsContainer) tagsContainer.style.display = 'none';
      this.visualOverlay.clear();
    }
  }

  /**
   * Wipes the recommendation and the board arrow.
   */
  public clearRecommendation(): void {
    this.latestRecommendation = null;
    this.visualOverlay.clear();
    this.updateRecommendation({ status: 'idle', errorMessage: 'Waiting for your turn...' });
  }

  private formatMoveDisplay(san: string, from?: string, to?: string, piece?: string, captured?: string): { main: string; details: string } {
    if (san === 'O-O') return { main: 'O-O', details: 'Castles Kingside (O-O)' };
    if (san === 'O-O-O') return { main: 'O-O-O', details: 'Castles Queenside (O-O-O)' };

    let name = 'Pawn';
    if (san.startsWith('N') || piece === 'n') { name = 'Knight'; }
    else if (san.startsWith('B') || piece === 'b') { name = 'Bishop'; }
    else if (san.startsWith('R') || piece === 'r') { name = 'Rook'; }
    else if (san.startsWith('Q') || piece === 'q') { name = 'Queen'; }
    else if (san.startsWith('K') || piece === 'k') { name = 'King'; }

    let details = `${name}`;
    if (from) details += ` from ${from}`;
    if (captured) details += ` captures ${to || ''}`;
    else if (to) details += ` to ${to}`;
    if (san.includes('=')) details += ` (Promote to Queen)`;
    if (san.includes('#')) details += ` Checkmate`;
    else if (san.includes('+')) details += ` (Check)`;

    return { main: san, details };
  }

  public toggleMinimize(): void {
    if (!this.hudElement) return;
    this.isMinimized = !this.isMinimized;
    this.hudElement.classList.toggle('minimized', this.isMinimized);
  }

  public setVisible(visible: boolean): void {
    if (!this.hudElement) return;
    this.hudElement.style.display = visible ? 'block' : 'none';
  }
}
