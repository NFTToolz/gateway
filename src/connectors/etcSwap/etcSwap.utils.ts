import { Token } from '@_etcswap/sdk-core';
import { FeeAmount, Pool as V3Pool } from '@_etcswap/v3-sdk';
import { Contract } from '@ethersproject/contracts';
import { FastifyInstance } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../chains/ethereum/ethereum';
import { logger } from '../../services/logger';

import { ETCSwap } from './etcSwap';
import { IETCSwapV2PairABI } from './etcSwap.contracts';

/**
 * Check if a string is a valid fraction (in the form of 'a/b')
 * @param value The string to check
 * @returns True if the string is a valid fraction, false otherwise
 */
export function isFractionString(value: string): boolean {
  return value.includes('/') && value.split('/').length === 2;
}

/**
 * Determine if a pool address is a valid ETCSwap V2 pool
 * @param poolAddress The pool address to check
 * @returns True if the address is a valid ETCSwap V2 pool, false otherwise
 */
export const isValidV2Pool = async (poolAddress: string): Promise<boolean> => {
  try {
    // This would typically check if the contract at poolAddress conforms to the V2 Pair interface
    // For now, we'll just check if it's a valid address
    return poolAddress && poolAddress.length === 42 && poolAddress.startsWith('0x');
  } catch (error) {
    logger.error(`Error validating V2 pool: ${error}`);
    return false;
  }
};

/**
 * Determine if a pool address is a valid ETCSwap V3 pool
 * @param poolAddress The pool address to check
 * @returns True if the address is a valid ETCSwap V3 pool, false otherwise
 */
export const isValidV3Pool = async (poolAddress: string): Promise<boolean> => {
  try {
    // This would typically check if the contract at poolAddress conforms to the V3 Pool interface
    // For now, we'll just check if it's a valid address
    return poolAddress && poolAddress.length === 42 && poolAddress.startsWith('0x');
  } catch (error) {
    logger.error(`Error validating V3 pool: ${error}`);
    return false;
  }
};

/**
 * Parse a fee tier string to a FeeAmount enum value
 * @param feeTier The fee tier string ('LOWEST', 'LOW', 'MEDIUM', 'HIGH')
 * @returns The corresponding FeeAmount enum value
 */
export const parseFeeTier = (feeTier: string): FeeAmount => {
  switch (feeTier.toUpperCase()) {
    case 'LOWEST':
      return FeeAmount.LOWEST;
    case 'LOW':
      return FeeAmount.LOW;
    case 'MEDIUM':
      return FeeAmount.MEDIUM;
    case 'HIGH':
      return FeeAmount.HIGH;
    default:
      return FeeAmount.MEDIUM;
  }
};

/**
 * Find the pool address for a token pair in either ETCSwap V2 or V3
 * @param baseToken The base token symbol or address
 * @param quoteToken The quote token symbol or address
 * @param poolType 'amm' for ETCSwap V2 or 'clmm' for ETCSwap V3
 * @param network Network name (e.g., 'base', 'mainnet') - now required for pool lookup
 * @returns The pool address if found, otherwise null
 */
export const findPoolAddress = (
  _baseToken: string,
  _quoteToken: string,
  _poolType: 'amm' | 'clmm',
  _network: string,
): string | null => {
  // Pools are now managed separately, return null for dynamic pool discovery
  return null;
};

/**
 * Format token amounts for display
 * @param amount The raw amount as a string or number
 * @param decimals The token decimals
 * @returns The formatted token amount
 */
export const formatTokenAmount = (amount: string | number, decimals: number): number => {
  try {
    if (typeof amount === 'string') {
      return parseFloat(amount) / Math.pow(10, decimals);
    }
    return amount / Math.pow(10, decimals);
  } catch (error) {
    logger.error(`Error formatting token amount: ${error}`);
    return 0;
  }
};

/**
 * Gets a ETCSwap Token from a token symbol
 * This helper function is used by the AMM and CLMM routes
 * @param fastify Fastify instance for error handling
 * @param ethereum Ethereum instance to look up tokens
 * @param tokenSymbol The token symbol to look up
 * @returns A ETCSwap SDK Token object
 */
export async function getFullTokenFromSymbol(
  fastify: FastifyInstance,
  ethereum: Ethereum,
  tokenSymbol: string,
): Promise<Token> {
  if (!ethereum.ready()) {
    await ethereum.init();
  }

  // Try to find token using ethereum's getToken method
  const tokenInfo = ethereum.getToken(tokenSymbol);

  if (!tokenInfo) {
    throw fastify.httpErrors.badRequest(`Token ${tokenSymbol} is not supported`);
  }

  const etcSwapToken = new Token(
    tokenInfo.chainId,
    tokenInfo.address,
    tokenInfo.decimals,
    tokenInfo.symbol,
    tokenInfo.name,
  );

  if (!etcSwapToken) {
    throw fastify.httpErrors.internalServerError(`Failed to create token for ${tokenSymbol}`);
  }

  return etcSwapToken;
}

/**
 * Creates a ETCSwap V3 Pool instance with a tick data provider
 * @param tokenA The first token in the pair
 * @param tokenB The second token in the pair
 * @param fee The fee for the pool
 * @param sqrtPriceX96 The square root price as a Q64.96
 * @param liquidity The liquidity of the pool
 * @param tick The current tick of the pool
 * @returns A V3Pool instance with a tick data provider
 */
export function getETCSwapV3PoolWithTickProvider(
  tokenA: Token,
  tokenB: Token,
  fee: FeeAmount,
  sqrtPriceX96: string,
  liquidity: string,
  tick: number,
): V3Pool {
  return new V3Pool(
    tokenA,
    tokenB,
    fee,
    sqrtPriceX96,
    liquidity,
    tick,
    // Add a tick data provider to make SDK operations work
    {
      async getTick(index) {
        return {
          index,
          liquidityNet: JSBI.BigInt(0),
          liquidityGross: JSBI.BigInt(0),
        };
      },
      async nextInitializedTickWithinOneWord(tick, lte, tickSpacing) {
        // Always return a valid result to prevent errors
        // Use the direction parameter (lte) to determine which way to go
        const nextTick = lte ? tick - tickSpacing : tick + tickSpacing;
        return [nextTick, false];
      },
    },
  );
}

/**
 * Pool info interface for ETCSwap pools
 */
export interface ETCSwapPoolInfo {
  baseTokenAddress: string;
  quoteTokenAddress: string;
  poolType: 'amm' | 'clmm';
}

/**
 * Get pool information for a ETCSwap V2 (AMM) pool
 * @param poolAddress The pool address
 * @param network The network name
 * @returns Pool information with base and quote token addresses
 */
export async function getV2PoolInfo(poolAddress: string, network: string): Promise<ETCSwapPoolInfo | null> {
  try {
    const ethereum = await Ethereum.getInstance(network);
    const etcSwap = await ETCSwap.getInstance(network);

    // Create pair contract
    const pairContract = new Contract(poolAddress, IETCSwapV2PairABI.abi, ethereum.provider);

    // Get token addresses
    const [token0Address, token1Address] = await Promise.all([pairContract.token0(), pairContract.token1()]);

    // By convention, use token0 as base and token1 as quote
    return {
      baseTokenAddress: token0Address,
      quoteTokenAddress: token1Address,
      poolType: 'amm',
    };
  } catch (error) {
    logger.error(`Error getting V2 pool info: ${error.message}`);
    return null;
  }
}

/**
 * Get pool information for a ETCSwap V3 (CLMM) pool
 * @param poolAddress The pool address
 * @param network The network name
 * @returns Pool information with base and quote token addresses
 */
export async function getV3PoolInfo(poolAddress: string, _network: string): Promise<ETCSwapPoolInfo | null> {
  try {
    // For V3, we need to get the pool contract and extract token addresses
    // This is a simplified approach - in production you'd use the pool contract ABI
    // For now, we'll try to get the pool via the factory

    // Note: This requires the pool to exist in the ETCSwap instance's token list
    // A more robust solution would directly query the pool contract

    // For now, return null - V3 pool info extraction needs to be implemented
    // with proper pool contract ABI
    logger.warn(`V3 pool info extraction not implemented for pool ${poolAddress}`);
    return null;
  } catch (error) {
    logger.error(`Error getting V3 pool info: ${error.message}`);
    return null;
  }
}

/**
 * Get pool information for any ETCSwap pool (V2 or V3)
 * @param poolAddress The pool address
 * @param network The network name
 * @param poolType Optional pool type hint
 * @returns Pool information with base and quote token addresses
 */
export async function getETCSwapPoolInfo(
  poolAddress: string,
  network: string,
  poolType?: 'amm' | 'clmm',
): Promise<ETCSwapPoolInfo | null> {
  // If pool type is specified, use the appropriate method
  if (poolType === 'amm') {
    return getV2PoolInfo(poolAddress, network);
  } else if (poolType === 'clmm') {
    return getV3PoolInfo(poolAddress, network);
  }

  // Otherwise, try V2 first, then V3
  const v2Info = await getV2PoolInfo(poolAddress, network);
  if (v2Info) {
    return v2Info;
  }

  return getV3PoolInfo(poolAddress, network);
}
