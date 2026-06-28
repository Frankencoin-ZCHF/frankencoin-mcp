/**
 * Webhook callback URL safety checks.
 *
 * Prevents webhook subscriptions from becoming an SSRF primitive against EC2
 * metadata, localhost, RFC1918/private networks, link-local addresses, and
 * private overlay domains. Production exceptions must be explicit via
 * WEBHOOK_ALLOWED_HOSTS (comma-separated exact hostnames).
 */

import dns from "node:dns/promises";
import net from "node:net";

const DEFAULT_BLOCKED_SUFFIXES = [
  ".local",
  ".localhost",
  ".localdomain",
  ".home.arpa",
  ".internal",
  ".intranet",
  ".lan",
  ".corp",
  ".consul",
];

const PUBLIC_OVERLAY_SUFFIXES = [
  // Tailscale Funnel uses ts.net hostnames and can resolve to CGNAT
  // addresses. Treat these as public HTTPS webhook hosts, but only by
  // hostname — raw 100.64/10 IP literals remain blocked.
  ".ts.net",
];

export function getAllowedWebhookHosts() {
  return new Set(
    (process.env.WEBHOOK_ALLOWED_HOSTS || "")
      .split(",")
      .map((s) => normalizeHostname(s.trim()))
      .filter(Boolean),
  );
}

export function assertSafeWebhookUrlSync(rawUrl) {
  const parsed = parseWebhookUrl(rawUrl);
  assertSafeHostnameSync(parsed.hostname, getAllowedWebhookHosts());
  return parsed;
}

/**
 * Resolve and validate a webhook destination immediately before delivery.
 * The returned safeAddress must be pinned by the caller's HTTP client lookup
 * callback; otherwise DNS rebinding can occur between validation and connect.
 */
export async function resolveSafeWebhookTarget(rawUrl) {
  const parsed = assertSafeWebhookUrlSync(rawUrl);
  const hostname = normalizeHostname(parsed.hostname);
  const allowedHosts = getAllowedWebhookHosts();
  if (allowedHosts.has(hostname)) return { parsed, hostname, safeAddress: null };
  if (isInsecureLocalhostAllowed(hostname)) return { parsed, hostname, safeAddress: null };

  if (net.isIP(hostname)) {
    return { parsed, hostname, safeAddress: { address: hostname, family: net.isIP(hostname) } };
  }

  // Block DNS names that resolve to private/reserved addresses too. Pin the
  // selected safe address in the HTTP client to avoid DNS rebinding between this
  // validation and the actual TCP/TLS connection.
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error("webhook hostname did not resolve");
  for (const record of records) {
    if (isBlockedIp(record.address) && !isAllowedPublicOverlayAddress(hostname, record.address)) {
      throw new Error(`webhook hostname resolves to blocked address ${record.address}`);
    }
  }
  return { parsed, hostname, safeAddress: records[0] };
}

// Backward-compatible name used by older code/tests.
export async function assertSafeWebhookUrlForDelivery(rawUrl) {
  return resolveSafeWebhookTarget(rawUrl);
}

function parseWebhookUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("url is required");
  }
  if (rawUrl.length > 2048) {
    throw new Error("url exceeds 2048 characters");
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("url is not a valid URL");
  }
  const host = normalizeHostname(parsed.hostname);
  const insecureLocalAllowed = parsed.protocol === "http:" && isInsecureLocalhostAllowed(host);
  if (parsed.protocol !== "https:" && !insecureLocalAllowed) {
    throw new Error("url must be HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("url must not contain credentials");
  }
  if (!parsed.hostname) {
    throw new Error("url hostname is required");
  }
  return parsed;
}

function assertSafeHostnameSync(hostname, allowedHosts) {
  const host = normalizeHostname(hostname);
  if (allowedHosts.has(host)) return;
  if (isInsecureLocalhostAllowed(host)) return;

  if (host === "localhost" || host === "ip6-localhost" || host === "ip6-loopback") {
    throw new Error("url hostname is blocked");
  }

  for (const suffix of DEFAULT_BLOCKED_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) {
      throw new Error(`url hostname suffix ${suffix} is blocked`);
    }
  }

  if (net.isIP(host) && isBlockedIp(host)) {
    throw new Error(`url IP address ${host} is blocked`);
  }
}

function normalizeHostname(hostname) {
  let host = (hostname || "").trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

function isInsecureLocalhostAllowed(hostname) {
  return process.env.WEBHOOK_ALLOW_INSECURE_LOCALHOST === "true" &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1");
}

function isAllowedPublicOverlayAddress(hostname, address) {
  return PUBLIC_OVERLAY_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)) &&
    isCgnatIpv4(address);
}

export function isBlockedIp(address) {
  const host = normalizeHostname(address);
  const family = net.isIP(host);
  if (family === 4) return isBlockedIpv4(host);
  if (family === 6) return isBlockedIpv6(host);
  return false;
}

function isBlockedIpv4(address) {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;

  return (
    a === 0 ||                         // this network
    a === 10 ||                        // RFC1918
    a === 127 ||                       // loopback
    (a === 169 && b === 254) ||        // link-local / EC2 metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) ||        // RFC1918
    isCgnatIpv4(address) ||            // CGNAT / private overlays by raw IP
    a >= 224                           // multicast/reserved
  );
}

function isCgnatIpv4(address) {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return a === 100 && b >= 64 && b <= 127;
}

function isBlockedIpv6(address) {
  const normalized = normalizeHostname(address);
  const mapped = ipv4MappedAddress(normalized);
  if (mapped) return isBlockedIpv4(mapped);

  const firstHextet = parseInt(normalized.split(":")[0] || "0", 16);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    (firstHextet & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (firstHextet & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (firstHextet & 0xff00) === 0xff00    // multicast ff00::/8
  );
}

function ipv4MappedAddress(normalizedIpv6) {
  if (!normalizedIpv6.startsWith("::ffff:")) return null;
  const rest = normalizedIpv6.slice("::ffff:".length);
  if (net.isIP(rest) === 4) return rest;

  const groups = rest.split(":");
  if (groups.length !== 2) return null;
  const hi = parseInt(groups[0], 16);
  const lo = parseInt(groups[1], 16);
  if (![hi, lo].every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}
