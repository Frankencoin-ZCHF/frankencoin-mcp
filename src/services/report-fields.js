// Public accounting fields used by the fixed reporting endpoints.
export const metricKeys = new Set(
  (
    "Challenge ForcedSale account accounts active address addresses amount amplifier annualInterestPPM asOf avgCollRatio " +
    "balance balanceInReserve blockheight borrowed chainId chains challengeLosses challengeProfits chf clones closed collateral " +
    "collateralDecimals collateralSymbol count counter created date days deadline decimals denied details discount " +
    "earnings earningsPerAnnum earningsPerToken equityInReserve excessProfit expiration exposures f fcsRedemptionFees feePPM feePaid feeTimeframe " +
    "forcedSaleLosses forcedSaleProfits fpsPrice fpsTotalSupply general hash hub inboundCapacity inboundEnabled inboundRate interest interestAverage " +
    "investFees isClone kind limit liquidity list lossCovered map mint minted mintedAdjusted minterProposalFees " +
    "mintersContribution module net newOwner nullable num open originals otherContributions otherLossClaims otherProfitClaims outboundCapacity " +
    "outboundEnabled outboundRate owner pool poolValueZchf position positionCount positionProposalFees positions previousOwner price priceAdjusted " +
    "priceToBookValue priceToEarnings proposer rate recentlyRedeemed recoveryCountdownSeconds recoveryPeriodSeconds redeemFees redemptionAnchor referrer referrerFee remoteChainSelector " +
    "remoteTokenAddress requested reserveContribution reserveReleased reserveRiskWiped riskRatio save savingsInterestCosts sender size sizeAdjusted status " +
    "symbol t thetaFromPositions thetaPerFpsToken thetaPerToken tickHigh tickLow timestamp token0 token1 total totalBalanceRaw " +
    "totalBorrowed totalContribution totalLimit totalMinted totalMintedRatio totalTheta totalValueLocked totals txHash updated usd usdAmount " +
    "usdDecimals usdPerZchf usdSymbol value version weightedRecentRedemptions withdraw year zchf zchfAmount zchfIsToken0 "
  )
    .trim()
    .split(" "),
);
