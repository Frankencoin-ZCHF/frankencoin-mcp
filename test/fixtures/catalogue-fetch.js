import { readFileSync } from "node:fs";
import { setFetchImpl as setFetch } from "../../src/upstream/client.js";

const tokens = JSON.parse(readFileSync(new URL("./ledger-deployments.json", import.meta.url)));
export const ledgerToken = (chainId, symbol) => tokens.find((r) => r.chainId === chainId && r.symbol === symbol)?.token;
export function setFetchImpl(handler) {
  setFetch(handler && ((url, options) => {
    const { pathname } = new URL(url);
    if (pathname === "/godeye/tokens") return Response.json({ tokens });
    if (pathname === "/tokens/1") return Response.json({ tokens: [{ network: 1, symbol: "USDC", decimals: 6, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }] });
    return handler(url, options);
  }));
}
