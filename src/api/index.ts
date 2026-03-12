import { Router } from 'express';
import { getStatus } from './controllers/status.js';
import { apiRateLimiter } from './middleware/rate-limit.js';
import { errorHandler } from './middleware/error.js';

/**
 * Main API router for /api endpoints.
 *
 * Mounts all API routes and applies global middleware.
 */
export function createApiRouter(): Router {
  const router = Router();

  // Apply rate limiting to all API routes
  router.use(apiRateLimiter);

  // Status endpoint
  router.get('/status', getStatus);

  // TODO: Add resource routers
  // router.use('/agents', agentsRouter);
  // router.use('/guilds', guildsRouter);
  // router.use('/servers', serversRouter);
  // router.use('/sessions', sessionsRouter);
  // router.use('/events', eventsRouter);

  // Error handler must be last
  router.use(errorHandler);

  return router;
}
