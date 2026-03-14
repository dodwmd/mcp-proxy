import type { Request, Response } from 'express';

/**
 * GET /api/status
 *
 * Returns server status and health information.
 */
export async function getStatus(_req: Request, res: Response): Promise<void> {
  res.json({
    data: {
      status: 'ok',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      features: {
        rest_api: true,
        event_bus: true,
        hot_reload: false, // TODO: Implement in Phase 6
        sse: false, // TODO: Implement SSE endpoint
      },
    },
    meta: {
      requestId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    },
  });
}
