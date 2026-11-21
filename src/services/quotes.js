import { krakenMarkets, indexedMarkets } from "./market-directory.js";
import { getOrLoad } from "../cache.js";
import { ValidationError, UpstreamError } from "../lib/errors.js";
import { FCS_CONTRACT } from "../lib/constants.js";
import { fetchJson } from "../upstream/client.js";
import { ethReadBatch } from "../upstream/eth.js";
import { ledgerToken } from "./ledgers.js";

const unit = 10n ** 18n;
export function atoms(amount, decimals = 18) {
  if (typeof amount !== "string" || !/^\d{1,45}(?:\.\d{1,18})?$/.test(amount))
    throw new ValidationError("Use a positive decimal string");
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals)
    throw new ValidationError("Excess decimal precision");
  const value = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (value <= 0n) throw new ValidationError("Amount must be positive");
  return value;
}
function decimal(value, decimals = 18) {
  const digits = value.toString().padStart(decimals + 1, "0");
  return (digits.slice(0, -decimals) + "." + digits.slice(-decimals)).replace(
    /\.?0+$/,
    "",
  );
}
function word(n) {
  return n.toString(16).padStart(64, "0");
}
export async function previewFcs({
  operation,
  amount,
  wallet,
  secondaryBudget,
  secondaryPrice,
}) {
  const n = atoms(amount);
  const entry = operation === "deposit";
  const selector = entry ? "0xef8b30f7" : "0x4cdad506";
  const calls = [selector + word(n)];
  if (wallet)
    calls.push(
      (entry ? "0x402d267d" : "0xd905777e") + wallet.slice(2).padStart(64, "0"),
    );
  if (
    Boolean(secondaryBudget) !== Boolean(secondaryPrice) ||
    (secondaryBudget && !entry)
  )
    throw new ValidationError(
      "Supply both secondary inputs for a deposit scenario",
    );
  const extra = secondaryBudget ? atoms(secondaryBudget) : 0n;
  if (extra) calls.push(selector + word(n + extra));
  const batch = await ethReadBatch(FCS_CONTRACT, calls);
  const [preview, ...rest] = batch.values.map(BigInt);
  const max = wallet ? rest.shift() : null;
  const result = {
    operation,
    amount,
    inputAsset: entry ? "ZCHF" : "FCS",
    outputAsset: entry ? "FCS" : "ZCHF",
    preview: decimal(preview),
    wallet,
    accountMaximum: max === null ? null : decimal(max),
    withinAccountMaximum: max === null ? null : n <= max,
    block: batch.block,
  };
  if (extra) {
    const secondary = (extra * unit) / atoms(secondaryPrice);
    const combined = preview + secondary;
    result.scenario = {
      primaryZchf: amount,
      secondaryBudgetZchf: secondaryBudget,
      assumedSecondaryPriceZchf: secondaryPrice,
      secondaryShares: decimal(secondary),
      combinedShares: decimal(combined),
      allPrimaryShares: decimal(rest[0]),
      averagePriceZchf:
        combined > 0n ? decimal(((n + extra) * unit) / combined) : null,
    };
  }
  return result;
}

const usdc = {
  1: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  10: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  137: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  8453: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  42161: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  43114: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
};
async function quoteDex(chainId, token, n, side) {
  if (!usdc[chainId]) return { status: "unsupported" };
  const buy = side === "buy";
  const srcToken = buy ? usdc[chainId] : token;
  const destToken = buy ? token : usdc[chainId];
  const params = new URLSearchParams({
    network: String(chainId),
    srcToken,
    destToken,
    srcDecimals: buy ? "6" : "18",
    destDecimals: buy ? "18" : "6",
    version: "6.2",
    side: side.toUpperCase(),
    amount: String(n),
  });
  const { priceRoute: r } = await fetchJson(
    "https://api.velora.xyz/prices?" + params,
    { source: "velora", timeout: 5000, retries: 0 },
  );
  if (
    r?.srcToken?.toLowerCase() !== srcToken ||
    r?.destToken?.toLowerCase() !== destToken ||
    Number(r.network) !== chainId ||
    r[buy ? "destAmount" : "srcAmount"] !== String(n) ||
    !/^[1-9]\d*$/.test(r[buy ? "srcAmount" : "destAmount"])
  )
    throw new UpstreamError("velora");
  return {
    status: "quoted",
    quoteAmount: decimal(BigInt(r[buy ? "srcAmount" : "destAmount"]), 6),
    blockNumber: Number.isSafeInteger(r.blockNumber) ? r.blockNumber : null,
  };
}
// Consume levels in provider order. Integer arithmetic preserves token and price precision.
export function walkBook(levels, n, side) {
  if (!Array.isArray(levels)) throw new UpstreamError("orderbook");
  let remaining = n,
    numerator = 0n,
    worst = null,
    previous = null;
  for (const [price, size] of levels) {
    const p = atoms(price),
      available = atoms(size);
    if (
      previous !== null &&
      ((side === "buy" && p < previous) || (side === "sell" && p > previous))
    )
      throw new UpstreamError("orderbook");
    previous = p;
    const fill = remaining < available ? remaining : available;
    numerator += p * fill;
    remaining -= fill;
    worst = price;
    if (!remaining) break;
  }
  return {
    status: remaining ? "insufficient_depth" : "quoted",
    filled: decimal(n - remaining),
    unfilled: decimal(remaining),
    quoteAmount: remaining ? null : decimal(numerator / unit),
    averagePrice: remaining ? null : decimal(numerator / n),
    worstLevel: worst,
  };
}
async function krakenQuote({ pair, quote: quoteAsset }, size, side) {
  const venue = "Kraken";
  const url =
    "https://api.kraken.com/0/public/Depth?pair=" + pair + "&count=500";
  // All sizes and chains use the same venue book. Retain the original observation
  // time, and give a failed book one short retry interval shared by its callers.
  const observation = await getOrLoad(
    "book:" + venue + ":" + pair,
    5000,
    async () => {
      try {
        const reply = await fetchJson(url, {
          source: venue.toLowerCase(),
          timeout: 5000,
          retries: 0,
        });
        if (reply.error?.length) throw new UpstreamError("kraken");
        const book = reply.result?.[pair];
        if (!Array.isArray(book?.asks) && !Array.isArray(book?.bids))
          throw new UpstreamError("orderbook");
        return { book, retrievedAt: new Date().toISOString() };
      } catch {
        return null;
      }
    },
  );
  if (!observation) return { venue, quoteAsset, status: "unavailable" };
  try {
    const levels = observation.book[side === "buy" ? "asks" : "bids"];
    return {
      venue,
      quoteAsset,
      ...walkBook(levels, size, side),
      retrievedAt: observation.retrievedAt,
    };
  } catch {
    return { venue, quoteAsset, status: "unavailable" };
  }
}

export async function liquidity({ asset, chainId, amount, side }) {
  const token = ledgerToken(chainId, asset),
    n = atoms(amount);
  const dex = getOrLoad(
    "quote:Velora:" + [token, chainId, side, n].join(":"),
    5000,
    async () => ({
      ...(await quoteDex(chainId, token, n, side)),
      retrievedAt: new Date().toISOString(),
    }),
  ).then(
    (quote) => ({ venue: "Velora", quoteAsset: "USDC", ...quote }),
    () => ({ venue: "Velora", quoteAsset: "USDC", status: "unavailable" }),
  );
  const books = async () => {
    if (asset !== "ZCHF") return { catalogue: null, quotes: [] };
    const catalogue = await krakenMarkets();
    const quotes = await Promise.all(
      (catalogue.markets ?? []).map((market) =>
        krakenQuote(market, n, side).catch(() => ({
          venue: "Kraken",
          quoteAsset: market.quote,
          status: "unavailable",
        })),
      ),
    );
    return { catalogue, quotes };
  };
  const [dexQuote, { catalogue, quotes }, indexed] = await Promise.all([
    dex,
    books(),
    indexedMarkets(asset),
  ]);
  const venues = [dexQuote, ...quotes];
  return {
    chainId,
    asset,
    amount,
    side,
    venues,
    discovery: {
      kraken: catalogue,
      indexed,
      scope:
        "Indexed tickers are reported markets. Sized fills require a supported book or routing adapter.",
    },
    scope:
      "Indicative quotes. CEX books are venue-wide. Fees, gas and settlement costs are excluded from book fills. Quote currencies are distinct.",
  };
}

export async function fcsVotes({ wallet }) {
  const calls = ["0x0d15fd77", "0xb535d4f0", "0x9e4b5745"];
  if (wallet) {
    const account = wallet.slice(2).padStart(64, "0");
    for (const selector of [
      "0x70a08231",
      "0xd8bff5a5",
      "0x84a7aa0c",
      "0xc9f72b67",
      "0xd905777e",
    ])
      calls.push(selector + account);
  }
  const { values, block } = await ethReadBatch(FCS_CONTRACT, calls);
  const [
    total,
    average,
    binding,
    balance,
    votes,
    relative,
    duration,
    maxRedeem,
  ] = values.map(BigInt);
  if (binding > 1n) throw new UpstreamError("eth");
  return {
    chainId: 1,
    block,
    totalVotesRaw: String(total),
    averageHoldingDurationRaw: String(average),
    binding: binding === 1n,
    account: wallet
      ? {
          wallet,
          balanceFcs: decimal(balance),
          votesRaw: String(votes),
          relativeVotesRaw: String(relative),
          holdingDurationRaw: String(duration),
          maxRedeemFcs: decimal(maxRedeem),
        }
      : null,
    scope:
      "Ethereum FCS contract reads. Holder votes exclude votes from external delegation proofs. Bridge vote snapshots have separate observation times.",
  };
}
