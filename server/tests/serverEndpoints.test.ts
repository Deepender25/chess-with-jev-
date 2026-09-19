import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { httpServer } from '../src/server.js';
import type { EvaluateResponse } from '../src/types.js';

interface HealthResponse {
  status: string;
  service: string;
  model: string;
  hasApiKey: boolean;
}

describe('Server HTTP Endpoints', () => {
  const PORT = 3099;
  const BASE_URL = `http://localhost:${PORT}`;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      httpServer.listen(PORT, '127.0.0.1', () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('GET /health should return 200 and status ok', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as HealthResponse;
    expect(data.status).toBe('ok');
    expect(data.service).toBe('chess-with-jev-backend');
  });

  it('POST /api/evaluate should evaluate a position and return decision', async () => {
    const res = await fetch(`${BASE_URL}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        turn: 'b',
        fullMoveNumber: 1,
        moves: ['e4']
      })
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as EvaluateResponse;
    expect(data.success).toBe(true);
    expect(data.decision).toBeDefined();
    expect(data.decision?.recommendedMove).toBeTruthy();
    expect(data.decision?.confidence).toBeGreaterThan(0);
    expect(data.decision?.latencyMs).toBeGreaterThanOrEqual(0);
  }, 30000);
});

