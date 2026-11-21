import { getOrLoad } from "../cache.js";
import { fetchJson } from "../upstream/client.js";
import { UpstreamError, ValidationError } from "../lib/errors.js";
import { ledgerToken } from "./token-directory.js";

export function bridgeMessage({ messageId }) {
  return getOrLoad("ccip:" + messageId, 15_000, async () => {
    const r = await fetchJson(
      "https://api.ccip.chain.link/v2/messages/" + messageId,
      { source: "ccip", timeout: 6000, retries: 0 },
    );
    const sourceChain = Number(r?.sourceNetworkInfo?.chainId),
      destinationChain = Number(r?.destNetworkInfo?.chainId);
    const sourceToken = await ledgerToken(sourceChain, "ZCHF"),
      destinationToken = await ledgerToken(destinationChain, "ZCHF");
    if (
      r.messageId?.toLowerCase() !== messageId ||
      !Array.isArray(r.tokenAmounts)
    )
      throw new UpstreamError("ccip");
    const matches = r.tokenAmounts.filter(
      (t) =>
        t.sourceTokenAddress?.toLowerCase() === sourceToken &&
        t.destTokenAddress?.toLowerCase() === destinationToken,
    );
    if (!matches.length)
      throw new ValidationError("Message has no supported ZCHF transfer");
    const hash = /^0x[\da-f]{64}$/i,
      address = /^0x[\da-f]{40}$/i;
    if (
      !hash.test(r.sendTransactionHash) ||
      !matches.every((t) => /^\d+$/.test(t.amount)) ||
      !address.test(r.sender) ||
      !address.test(r.receiver) ||
      (r.receiptTransactionHash != null && !hash.test(r.receiptTransactionHash))
    )
      throw new UpstreamError("ccip");
    return {
      messageId,
      sourceChain,
      destinationChain,
      sender: r.sender,
      receiver: r.receiver,
      amountsRaw: matches.map((t) => t.amount),
      sourceToken,
      destinationToken,
      sourceTx: r.sendTransactionHash,
      destinationTx: r.receiptTransactionHash ?? null,
      status: [
        "SENT",
        "UNKNOWN",
        "FAILED",
        "SUCCESS",
        "IN_PROGRESS",
        "BLESSED",
        "UNCONFIRMED",
        "VERIFIED",
        "EXECUTED",
      ].includes(r.status)
        ? r.status
        : null,
      retrievedAt: new Date().toISOString(),
      source: "Chainlink CCIP message index",
    };
  });
}

export async function bridgeList({ chainId, after, limit }) {
  const token = await ledgerToken(chainId, "ZCHF");
  const params = new URLSearchParams({
    sourceTokenAddress: token,
    limit: String(limit),
  });
  if (after) params.set("cursor", after);
  return getOrLoad("ccip-list:" + chainId + ":" + params, 15_000, async () => {
    const json = await fetchJson(
      "https://api.ccip.chain.link/v2/messages?" + params,
      { source: "ccip", timeout: 6000, retries: 0 },
    );
    if (
      !Array.isArray(json?.data) ||
      typeof json.pagination?.hasNextPage !== "boolean"
    )
      throw new UpstreamError("ccip");
    const messages = [];
    for (const row of json.data) {
      if (
        Number(row.sourceNetworkInfo?.chainId) !== chainId ||
        row.sourceTokenAmount?.tokenAddress?.toLowerCase() !== token
      )
        continue;
      if (
        !/^0x[\da-f]{64}$/i.test(row.messageId) ||
        !/^0x[\da-f]{64}$/i.test(row.sendTransactionHash) ||
        !/^\d+$/.test(row.sourceTokenAmount.tokenAmount)
      )
        throw new UpstreamError("ccip");
      messages.push({
        messageId: row.messageId,
        sourceTx: row.sendTransactionHash,
        sourceChain: chainId,
        destinationChain: Number(row.destNetworkInfo?.chainId),
        amountRaw: row.sourceTokenAmount.tokenAmount,
      });
    }
    const next = json.pagination.hasNextPage ? json.pagination.cursor : null;
    if (
      json.pagination.hasNextPage &&
      (typeof next !== "string" ||
        !next.length ||
        next.length > 2000 ||
        next === after)
    )
      throw new UpstreamError("ccip");
    return {
      messages,
      nextCursor: next,
      retrievedAt: new Date().toISOString(),
      scope:
        "Provider page filtered by source chain and token. Empty pages with a cursor can be continued. Read each message to confirm its destination token and delivery.",
    };
  });
}
