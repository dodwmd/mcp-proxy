/**
 * Base API error class.
 * All API errors should extend this class for consistent error handling.
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NotFoundError extends ApiError {
  constructor(resource: string, id: string) {
    super(404, 'NOT_FOUND', `${resource} not found: ${id}`);
  }
}

export class ValidationError extends ApiError {
  constructor(details: Record<string, string>) {
    super(400, 'VALIDATION_ERROR', 'Request validation failed', details);
  }
}

export class ConflictError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(409, 'CONFLICT', message, details);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message: string) {
    super(403, 'FORBIDDEN', message);
  }
}

export class RateLimitError extends ApiError {
  constructor(retryAfter?: number) {
    super(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests', { retryAfter });
  }
}
