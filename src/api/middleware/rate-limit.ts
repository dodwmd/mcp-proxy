import rateLimit from 'express-rate-limit';
import { RateLimitError } from '../types/errors.js';

/**
 * Rate limiting middleware for API endpoints.
 *
 * Limits requests per IP address to prevent abuse.
 * Returns 429 Too Many Requests when limit exceeded.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 100, // 100 requests per minute per IP
  standardHeaders: 'draft-7', // Return rate limit info in RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  handler: (_req, _res, _next) => {
    throw new RateLimitError(60); // Retry after 60 seconds
  },
});

/**
 * Stricter rate limit for expensive operations (like server test endpoint).
 */
export const strictRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 10, // 10 requests per minute per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, _next) => {
    throw new RateLimitError(60);
  },
});
