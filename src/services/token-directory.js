import { apiFetch } from "../upstream/frankencoin.js";
import { UpstreamError, ValidationError } from "../lib/errors.js";

export async function ledgerDeployments() {
  const { tokens } = await apiFetch("/godeye/tokens");
  if (!Array.isArray(tokens) || !tokens.length) throw new UpstreamError("ledger");
  const seen = new Set();
  return tokens.map(({ chainId, symbol, token }) => {
    const key = chainId + ":" + symbol;
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || typeof symbol !== "string" ||
        !/^0x[0-9a-f]{40}$/i.test(token) || seen.has(key)) throw new UpstreamError("ledger");
    seen.add(key);
    return { chainId, symbol, token: token.toLowerCase() };
  });
}

export async function ledgerToken(chainId, symbol) {
  const deployments = await ledgerDeployments();
  const deployment = deployments.find((d) => d.chainId === chainId && d.symbol === symbol);
  if (!deployment) throw new ValidationError("Token is not indexed on the requested chain");
  return deployment.token;
}
