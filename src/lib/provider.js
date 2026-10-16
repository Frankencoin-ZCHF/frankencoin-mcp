import { MissingSecretError, TimeoutError, UpstreamError } from "./errors.js";

// Safe, structured provider diagnostics: never include exception text, URLs or secrets.
export function providerFailure(error) {
  return {
    status: error instanceof MissingSecretError ? "unconfigured" : "unavailable",
    code: error instanceof MissingSecretError ? "not_configured" : error instanceof TimeoutError ? "timeout" : "upstream_error",
    httpStatus: error instanceof UpstreamError ? error.upstreamStatus ?? null : null,
    checkedAt: new Date().toISOString(),
    asOf: null,
  };
}

export async function observe(request, usable = (v) => v != null) {
  try {
    const value = await request;
    const available = usable(value);
    return { value: available ? value : null, health: {
      status: available ? "available" : "unavailable", code: available ? null : "empty_response",
      checkedAt: new Date().toISOString(), asOf: null,
    } };
  } catch (error) {
    return { value: null, health: providerFailure(error) };
  }
}

export function availability(health) {
  const states = Object.values(health).map((h) => h.status);
  return states.every((s) => s === "available") ? "available" : states.some((s) => s === "available" || s === "partial") ? "partial" : "unavailable";
}
