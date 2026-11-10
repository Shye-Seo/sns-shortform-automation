export type ErrorCode =
  | 'CONFIG'
  | 'VALIDATION'
  | 'MEDIA'
  | 'NETWORK'
  | 'PLATFORM'
  | 'APPROVAL'
  | 'RATE_LIMIT'
  | 'EXTERNAL';

export interface ShortformErrorOptions {
  code: ErrorCode;
  details?: Record<string, unknown>;
  retryable?: boolean;
  cause?: unknown;
}

/**
 * One error type for the whole pipeline so the CLI can print a single,
 * readable line and the publishers can decide on retry from `retryable`
 * instead of string matching.
 */
export class ShortformError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(message: string, options: ShortformErrorOptions) {
    super(message);
    this.name = 'ShortformError';
    this.code = options.code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function asShortformError(error: unknown, fallbackCode: ErrorCode = 'EXTERNAL'): ShortformError {
  if (error instanceof ShortformError) return error;
  if (error instanceof Error) {
    return new ShortformError(error.message, { code: fallbackCode, cause: error });
  }
  return new ShortformError(String(error), { code: fallbackCode });
}

export function assertCondition(
  condition: unknown,
  message: string,
  options: ShortformErrorOptions = { code: 'VALIDATION' },
): asserts condition {
  if (!condition) {
    throw new ShortformError(message, options);
  }
}
