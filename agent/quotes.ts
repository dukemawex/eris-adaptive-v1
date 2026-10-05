/**
 * Exact on-chain quotes (eth_call) for a candidate trade size, using the same quoting contracts the
 * runtime itself uses to set minOut (Uniswap QuoterV2, Balancer queries.querySwap, Curve get_dy).
 * Reads only; nothing here signs or sends.
 */
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Address, type PublicClient } from "viem";
import { balancerQueriesAbi, curveTricryptoAbi, quoterV2Abi } from "@eris/sdk/abis.js";
import { BALANCER, UNISWAP } from "@eris/sdk/constants.js";
import { marketFor, tokenInfo } from "@eris/sdk/markets.js";
import type { Protocol } from "./features.js";
import type { Side } from "./amm.js";

export type Quoter = (protocol: Protocol, base: string, side: Side, amountInRaw: bigint) => Promise<bigint | null>;

/** A quoter bound to the runtime's read-only client, with a per-decision call budget. */
export function onchainQuoter(client: PublicClient, budget: { left: number }): Quoter {
  return async (protocol, base, side, amountInRaw) => {
    if (budget.left <= 0 || amountInRaw <= 0n) return null;
    budget.left--;
    try {
      const market = marketFor(protocol, base);
      if (!market) return null;
      const baseAddr = tokenInfo(base).address as Address;
      if (protocol === "uniswap") {
        const leg = market.uniswap!;
        const usdc = tokenInfo("USDC").address as Address;
        const [tokenIn, tokenOut] = side === "sell" ? [baseAddr, usdc] : [usdc, baseAddr];
        const data = encodeFunctionData({
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn: amountInRaw, fee: leg.fee, sqrtPriceLimitX96: 0n }],
        });
        const res = await client.call({ to: UNISWAP.quoterV2 as Address, data });
        const [out] = decodeFunctionResult({
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          data: res.data ?? "0x",
        }) as readonly [bigint, ...unknown[]];
        return out;
      }
      if (protocol === "balancer") {
        const leg = market.balancer!;
        const [assetIn, assetOut] = side === "sell" ? [baseAddr, leg.stable] : [leg.stable, baseAddr];
        const data = encodeFunctionData({
          abi: balancerQueriesAbi,
          functionName: "querySwap",
          args: [
            { poolId: leg.poolId, kind: 0, assetIn, assetOut, amount: amountInRaw, userData: "0x" },
            { sender: zeroAddress, fromInternalBalance: false, recipient: zeroAddress, toInternalBalance: false },
          ],
        });
        const res = await client.call({ to: BALANCER.queries as Address, data });
        return decodeFunctionResult({ abi: balancerQueriesAbi, functionName: "querySwap", data: res.data ?? "0x" }) as bigint;
      }
      const leg = market.curve!;
      const [i, j] = side === "sell" ? [leg.baseIndex, leg.quoteIndex] : [leg.quoteIndex, leg.baseIndex];
      return (await client.readContract({
        address: leg.pool,
        abi: curveTricryptoAbi,
        functionName: "get_dy",
        args: [BigInt(i), BigInt(j), amountInRaw],
      })) as bigint;
    } catch {
      return null;
    }
  };
}
