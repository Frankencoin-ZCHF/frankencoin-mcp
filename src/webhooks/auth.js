/**
 * Admin-token helpers for webhook management endpoints/tools.
 *
 * Data tools remain public. Webhook CRUD/test/status is admin-only because it
 * can trigger outbound HTTP delivery and reveal receiver infrastructure.
 */

import crypto from "node:crypto";

const TOKEN_ENV = "WEBHOOK_ADMIN_TOKEN";

export function getWebhookAdminToken() {
  return (process.env[TOKEN_ENV] || "").trim();
}

export function isAuthorizedRequest(req) {
  const expected = getWebhookAdminToken();
  if (expected.length < 32) {
    return { ok: false, status: 503, error: "webhook management is unavailable" };
  }

  const authorization = req.headers.authorization || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const header = (req.headers["x-webhook-admin-token"] || "").trim();

  if (constantTimeEqual(bearer, expected) || constantTimeEqual(header, expected)) {
    return { ok: true };
  }
  return { ok: false, status: 401, error: "unauthorized" };
}

export function requireWebhookAdminToken(provided) {
  const expected = getWebhookAdminToken();
  if (expected.length < 32) throw new Error(`${TOKEN_ENV} is not configured`);
  if (!constantTimeEqual(String(provided || "").trim(), expected)) throw new Error("unauthorized");
}

function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}
