/**
 * Typed errors + a single error mapper. No string-sniffing of messages anywhere.
 *
 * Every error carries an internal `message` (full detail → stderr only) and a
 * `clientMessage` (a fixed, input-free, safe string → responses). The mapper maps
 * error TYPE → HTTP status and a safe client message. Upstream URLs, secret
 * presence, file paths and stack traces MUST never reach a response (SECURITY §5).
 */

export class AppError extends Error {
  constructor(message, { code = "internal_error", status = 500, clientMessage = "internal server error" } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.clientMessage = clientMessage;
  }
}

/** Bad input / failed schema or GraphQL validation. clientMessage is the (safe) reason. */
export class ValidationError extends AppError {
  constructor(reason = "invalid request parameters") {
    super(reason, { code: "invalid_request", status: 400, clientMessage: reason });
  }
}

/** Unknown tool / unknown path. */
export class NotFoundError extends AppError {
  constructor(message = "not found") {
    super(message, { code: "not_found", status: 404, clientMessage: "not found" });
  }
}

/** Reserved — no auth in this server, but kept for completeness. */
export class AuthError extends AppError {
  constructor(message = "unauthorized") {
    super(message, { code: "unauthorized", status: 401, clientMessage: "unauthorized" });
  }
}

export class RateLimitError extends AppError {
  constructor(message = "rate limit exceeded") {
    super(message, { code: "rate_limited", status: 429, clientMessage: "rate limit exceeded" });
  }
}

export class BusyError extends AppError {
  constructor(message = "server busy") {
    super(message, { code: "busy", status: 503, clientMessage: "server busy, retry shortly" });
  }
}

/** Upstream request exceeded its deadline. */
export class TimeoutError extends AppError {
  constructor(source) {
    super(`upstream timeout: ${source}`, { code: "upstream_timeout", status: 504, clientMessage: "upstream timed out" });
    this.source = source;
  }
}

/** Upstream returned a non-2xx or an otherwise unusable response. */
export class UpstreamError extends AppError {
  constructor(source, status) {
    super(`upstream error: ${source}${status ? ` (${status})` : ""}`, {
      code: "upstream_error",
      status: 502,
      clientMessage: "upstream data source error",
    });
    this.source = source;
    this.upstreamStatus = status;
  }
}

/**
 * An optional secret (CoinGecko / Dune key) is not configured. Services CATCH this
 * and degrade to partial data — it should never reach the client mapper. If it
 * somehow does, it is mapped to the generic upstream message (never disclosing config).
 */
export class MissingSecretError extends AppError {
  constructor(source) {
    super(`missing secret: ${source}`, { code: "upstream_error", status: 502, clientMessage: "upstream data source error" });
    this.source = source;
  }
}

/** Map any thrown value to { status, clientMessage, code } using its TYPE, never its text. */
export function mapError(err) {
  if (err instanceof AppError) {
    return { status: err.status, clientMessage: err.clientMessage, code: err.code };
  }
  return { status: 500, clientMessage: "internal server error", code: "internal_error" };
}

/** Strip CR/LF from a client-derived value before it enters a log line (SECURITY §5.3). */
export function sanitizeForLog(value, max = 200) {
  return String(value).replace(/[\r\n]+/g, " ").slice(0, max);
}
