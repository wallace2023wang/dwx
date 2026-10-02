export class DomainError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
    this.status = options.status || 400;
    this.retryable = options.retryable === true;
  }
}

export function domainErrorResult(error, fallbackStatus = 400) {
  return {
    status: error?.status || fallbackStatus,
    error: error instanceof Error ? error.message : String(error),
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.details ? { details: error.details } : {}),
    ...(error?.retryable != null ? { retryable: error.retryable } : {}),
  };
}
