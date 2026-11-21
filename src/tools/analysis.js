import { pools } from "../services/pools.js";
import { pegHistory, stress } from "../services/monitor.js";
import { z } from "zod";
import { ledgerReport } from "../services/ledgers.js";
import { activity, activityKinds } from "../services/activity.js";
import { operationReport, reportKinds } from "../services/operations.js";
import { previewFcs, fcsVotes, liquidity } from "../services/quotes.js";
import { bridgeMessage, bridgeList } from "../services/bridge.js";
import { ValidationError } from "../lib/errors.js";

const address = z
  .string()
  .regex(/^0x[\da-f]{40}$/i)
  .toLowerCase();
const hash = z
  .string()
  .regex(/^0x[\da-f]{64}$/i)
  .toLowerCase();
const integer = (min, max) => z.coerce.number().int().min(min).max(max);
const chainId = integer(1, Number.MAX_SAFE_INTEGER)
  .default(1)
  .describe("EVM chain ID. Defaults to Ethereum.");
const asset = z
  .enum(["ZCHF", "FCS", "FPS"])
  .default("ZCHF")
  .describe("Token in the Frankencoin ledger catalogue.");
const wallet = address.optional().describe("Pseudonymous EVM address.");
const amount = z
  .string()
  .regex(/^\d{1,45}(?:\.\d{1,18})?$/)
  .describe("Positive token quantity as a decimal string.");
const window = {
  from: integer(0, 9999999999).optional().describe("Inclusive Unix seconds."),
  to: integer(0, 9999999999)
    .optional()
    .describe(
      "Exclusive Unix seconds for event windows, snapshot time for holders.",
    ),
};
const limit = integer(1, 100)
  .default(20)
  .describe("Maximum rows per page or per event feed.");
const offset = integer(0, 1000000)
  .default(0)
  .describe("Zero-based page offset.");
function define(name, description, fields, handler) {
  const input = z.object(fields).strict();
  const schema = z.toJSONSchema(input, { io: "input" });
  return {
    name,
    description,
    input,
    params: Object.entries(schema.properties).map(([name, p]) => ({
      name,
      type: p.type,
      description: p.description,
      required: schema.required?.includes(name) ?? false,
    })),
    handler: (a) => {
      if (a.from !== undefined && a.to !== undefined && a.from >= a.to)
        throw new ValidationError("Supply an increasing time window");
      return handler(a);
    },
  };
}
export const analysisTools = [
  define(
    "get_token_ledger",
    "Address-only holder concentration, wallet flows and history, cross-chain balances and daily adoption. Amounts are token units. Transfers alone do not establish trades.",
    {
      view: z
        .enum([
          "graph",
          "holders",
          "wallet",
          "journey",
          "transfers",
          "portfolio",
          "timeline",
        ])
        .describe("Choose a ledger view."),
      chainId,
      asset,
      wallet,
      ...window,
      limit,
      offset,
    },
    ledgerReport,
  ),
  define(
    "get_protocol_activity",
    "Find indexed loan draws and repayments, savings, FCS, equity, amplifier and governance events by transaction hash or period. Continue a truncated feed with events and its cursor.",
    {
      view: z
        .enum(["transaction", "events", "changes"])
        .describe("Lookup mode."),
      kind: z
        .enum(activityKinds)
        .default("transfers")
        .describe("Event feed for events mode."),
      chainId,
      asset,
      txHash: hash
        .optional()
        .describe("Transaction hash for transaction mode."),
      ...window,
      limit,
      after: z
        .string()
        .max(2000)
        .optional()
        .describe("Opaque cursor for the same window and feed."),
    },
    activity,
  ),
  define(
    "get_protocol_report",
    "Read borrower, savings, referral, collateral, revenue, amplifier, FCS fee or bridge accounting reports. Address-scoped reports require a hexadecimal address.",
    {
      report: z.enum(reportKinds).describe("Accounting report."),
      address: wallet,
      version: integer(1, 2).optional().describe("Minting position version."),
      year: integer(2023, 2100).optional().describe("Annual report year."),
      ...window,
      limit,
      offset,
    },
    operationReport,
  ),
  define(
    "get_dex_pools",
    "List provider-indexed DEX pools for a token and chain, with pair addresses, USD liquidity and 24-hour volume.",
    { chainId, asset },
    pools,
  ),
  define(
    "get_liquidity",
    "Estimate a sized buy or sell from DEX routing and available CEX books, with separate quote currencies and explicit unfilled depth.",
    {
      chainId,
      asset,
      quoteToken: address.optional().describe("DEX counter-token contract on the requested chain. Defaults to the router-listed USDC."),
      side: z
        .enum(["buy", "sell"])
        .describe("Side from the token holder's perspective."),
      amount,
    },
    liquidity,
  ),
  define(
    "preview_fcs",
    "Preview an Ethereum FCS deposit or redemption at one canonical block, optionally checking the address limit or modelling a primary and secondary investment.",
    {
      operation: z
        .enum(["deposit", "redeem"])
        .describe("Deposit ZCHF or redeem FCS."),
      amount,
      wallet,
      secondaryBudget: amount
        .optional()
        .describe("Additional ZCHF allocated to secondary shares."),
      secondaryPrice: amount
        .optional()
        .describe("Assumed secondary price in ZCHF per FCS."),
    },
    previewFcs,
  ),
  define(
    "get_peg_history",
    "Check observed ZCHF/CHF trades and peg-deviation thresholds over completed Kraken candles.",
    {
      ...window,
      limit,
      interval: z.coerce
        .number()
        .int()
        .pipe(z.union([1, 5, 15, 30, 60, 240, 1440].map((v) => z.literal(v))))
        .default(60)
        .describe("Candle minutes."),
      thresholdBps: integer(1, 10000)
        .default(50)
        .describe("Absolute deviation from one CHF in basis points."),
    },
    pegHistory,
  ),
  define(
    "stress_collateral",
    "Apply a price decline to reported CHF collateral values and compare with outstanding ZCHF debt.",
    {
      address: address
        .optional()
        .describe("Optional collateral token address."),
      shockPercent: z.coerce
        .number()
        .min(0)
        .max(100)
        .describe("Assumed uniform price decline, percent."),
    },
    stress,
  ),
  define(
    "get_fcs_votes",
    "Read FCS binding, total votes and optional wallet balance, votes, holding duration and maximum redemption at one Ethereum block.",
    { wallet },
    fcsVotes,
  ),
  define(
    "get_bridge_message",
    "Look up both legs and delivery status of a supported cross-chain ZCHF transfer by Chainlink CCIP message ID.",
    {
      messageId: hash
        .optional()
        .describe(
          "CCIP message ID for a confirmed lookup. Omit to page through outbound messages.",
        ),
      chainId,
      limit,
      after: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("CCIP list cursor."),
    },
    (a) => (a.messageId ? bridgeMessage(a) : bridgeList(a)),
  ),
];
