import { Token, CurrencyAmount, Percent, TradeType } from '@_etcswap/sdk-core';
import { Route as V2Route, Trade as V2Trade } from '@_etcswap/v2-sdk';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  QuoteSwapRequestType,
  QuoteSwapResponseType,
  QuoteSwapRequest,
  QuoteSwapResponse,
} from '../../../schemas/amm-schema';
import { logger } from '../../../services/logger';
import { ETCSwap } from '../etcSwap';
import { formatTokenAmount, getETCSwapPoolInfo } from '../etcSwap.utils';

async function quoteAmmSwap(
  etcSwap: ETCSwap,
  poolAddress: string,
  baseToken: Token,
  quoteToken: Token,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct?: number,
): Promise<any> {
  try {
    // Get the V2 pair
    const pair = await etcSwap.getV2Pool(baseToken, quoteToken, poolAddress);
    if (!pair) {
      throw new Error(`Pool not found for ${baseToken.symbol}-${quoteToken.symbol}`);
    }

    // Determine which token is being traded (exact in/out)
    const exactIn = side === 'SELL';
    const [inputToken, outputToken] = exactIn ? [baseToken, quoteToken] : [quoteToken, baseToken];

    // Create a route for the trade
    const route = new V2Route([pair], inputToken, outputToken);

    // Create the V2 trade
    let trade;
    if (exactIn) {
      // For SELL (exactIn), we use the input amount and EXACT_INPUT trade type
      const inputAmount = CurrencyAmount.fromRawAmount(
        inputToken,
        Math.floor(amount * Math.pow(10, inputToken.decimals)).toString(),
      );
      trade = new V2Trade(route, inputAmount, TradeType.EXACT_INPUT);
    } else {
      // For BUY (exactOut), we use the output amount and EXACT_OUTPUT trade type
      const outputAmount = CurrencyAmount.fromRawAmount(
        outputToken,
        Math.floor(amount * Math.pow(10, outputToken.decimals)).toString(),
      );
      trade = new V2Trade(route, outputAmount, TradeType.EXACT_OUTPUT);
    }

    // Calculate slippage-adjusted amounts
    const slippageTolerance = new Percent(Math.floor((slippagePct ?? etcSwap.config.slippagePct) * 100), 10000);

    const minAmountOut = exactIn
      ? trade.minimumAmountOut(slippageTolerance).quotient.toString()
      : trade.outputAmount.quotient.toString();

    const maxAmountIn = exactIn
      ? trade.inputAmount.quotient.toString()
      : trade.maximumAmountIn(slippageTolerance).quotient.toString();

    // Calculate amounts - trade object has inputAmount and outputAmount for both types
    const estimatedAmountIn = formatTokenAmount(trade.inputAmount.quotient.toString(), inputToken.decimals);

    const estimatedAmountOut = formatTokenAmount(trade.outputAmount.quotient.toString(), outputToken.decimals);

    const minAmountOutValue = formatTokenAmount(minAmountOut, outputToken.decimals);
    const maxAmountInValue = formatTokenAmount(maxAmountIn, inputToken.decimals);

    // Calculate price impact
    const priceImpact = parseFloat(trade.priceImpact.toSignificant(4));

    return {
      poolAddress,
      estimatedAmountIn,
      estimatedAmountOut,
      minAmountOut: minAmountOutValue,
      maxAmountIn: maxAmountInValue,
      priceImpact,
      inputToken,
      outputToken,
      trade,
      // Add raw values for execution
      rawAmountIn: trade.inputAmount.quotient.toString(),
      rawAmountOut: trade.outputAmount.quotient.toString(),
      rawMinAmountOut: minAmountOut,
      rawMaxAmountIn: maxAmountIn,
      pathAddresses: trade.route.path.map((token) => token.address),
    };
  } catch (error) {
    logger.error(`Error quoting AMM swap: ${error.message}`);
    // Check for insufficient reserves error from ETCSwap SDK
    if (error.isInsufficientReservesError || error.name === 'InsufficientReservesError') {
      throw new Error(`Insufficient liquidity in pool for ${baseToken.symbol}-${quoteToken.symbol}`);
    }
    throw error;
  }
}

export async function getETCSwapAmmQuote(
  _fastify: FastifyInstance,
  network: string,
  poolAddress: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct?: number,
): Promise<{
  quote: any;
  etcSwap: any;
  ethereum: any;
  baseTokenObj: any;
  quoteTokenObj: any;
}> {
  // Get instances
  const etcSwap = await ETCSwap.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  if (!ethereum.ready()) {
    logger.info('Ethereum instance not ready, initializing...');
    await ethereum.init();
  }

  // Resolve tokens
  const baseTokenObj = etcSwap.getTokenBySymbol(baseToken);
  const quoteTokenObj = etcSwap.getTokenBySymbol(quoteToken);

  if (!baseTokenObj) {
    logger.error(`Base token not found: ${baseToken}`);
    throw new Error(`Base token not found: ${baseToken}`);
  }

  if (!quoteTokenObj) {
    logger.error(`Quote token not found: ${quoteToken}`);
    throw new Error(`Quote token not found: ${quoteToken}`);
  }

  logger.info(`Base token: ${baseTokenObj.symbol}, address=${baseTokenObj.address}, decimals=${baseTokenObj.decimals}`);
  logger.info(
    `Quote token: ${quoteTokenObj.symbol}, address=${quoteTokenObj.address}, decimals=${quoteTokenObj.decimals}`,
  );

  // Get the quote
  const quote = await quoteAmmSwap(
    etcSwap,
    poolAddress,
    baseTokenObj,
    quoteTokenObj,
    amount,
    side as 'BUY' | 'SELL',
    slippagePct,
  );

  if (!quote) {
    throw new Error('Failed to get swap quote');
  }

  return {
    quote,
    etcSwap,
    ethereum,
    baseTokenObj,
    quoteTokenObj,
  };
}

async function formatSwapQuote(
  fastify: FastifyInstance,
  network: string,
  poolAddress: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct?: number,
): Promise<QuoteSwapResponseType> {
  logger.info(
    `formatSwapQuote: poolAddress=${poolAddress}, baseToken=${baseToken}, quoteToken=${quoteToken}, amount=${amount}, side=${side}, network=${network}`,
  );

  try {
    // Use the extracted quote function
    const { quote, ethereum } = await getETCSwapAmmQuote(
      fastify,
      network,
      poolAddress,
      baseToken,
      quoteToken,
      amount,
      side,
      slippagePct,
    );

    logger.info(
      `Quote result: estimatedAmountIn=${quote.estimatedAmountIn}, estimatedAmountOut=${quote.estimatedAmountOut}`,
    );

    // Calculate balance changes based on which tokens are being swapped
    const baseTokenBalanceChange = side === 'BUY' ? quote.estimatedAmountOut : -quote.estimatedAmountIn;
    const quoteTokenBalanceChange = side === 'BUY' ? -quote.estimatedAmountIn : quote.estimatedAmountOut;

    logger.info(
      `Balance changes: baseTokenBalanceChange=${baseTokenBalanceChange}, quoteTokenBalanceChange=${quoteTokenBalanceChange}`,
    );

    // Get gas estimate for V2 swap
    const pathLength = quote.pathAddresses.length;
    const estimatedGasValue = pathLength * 150000; // Approximate gas per swap
    const gasPrice = await ethereum.provider.getGasPrice();
    logger.info(`Gas price from provider: ${gasPrice.toString()}`);

    // Calculate gas cost
    const estimatedGasBN = BigNumber.from(estimatedGasValue.toString());
    const gasCostRaw = gasPrice.mul(estimatedGasBN);
    const gasCost = formatTokenAmount(gasCostRaw.toString(), 18); // ETC has 18 decimals
    logger.info(`Gas cost: ${gasCost} ETC`);

    // Calculate price based on side
    // For SELL: price = quote received / base sold
    // For BUY: price = quote needed / base received
    const price =
      side === 'SELL'
        ? quote.estimatedAmountOut / quote.estimatedAmountIn
        : quote.estimatedAmountIn / quote.estimatedAmountOut;

    // Format gas price as Gwei
    const gasPriceGwei = formatTokenAmount(gasPrice.toString(), 9); // Convert to Gwei
    logger.info(`Gas price in Gwei: ${gasPriceGwei}`);

    // Calculate price impact percentage
    const priceImpactPct = quote.priceImpact;

    // Determine token addresses for computed fields
    const tokenIn = quote.inputToken.address;
    const tokenOut = quote.outputToken.address;

    // Calculate fee (V2 has 0.3% fixed fee)
    const fee = quote.estimatedAmountIn * 0.003;

    // Calculate price with slippage
    // For SELL: worst price = minAmountOut / estimatedAmountIn (minimum quote per base)
    // For BUY: worst price = maxAmountIn / estimatedAmountOut (maximum quote per base)
    const priceWithSlippage =
      side === 'SELL' ? quote.minAmountOut / quote.estimatedAmountIn : quote.maxAmountIn / quote.estimatedAmountOut;

    return {
      // Base QuoteSwapResponse fields in correct order
      poolAddress,
      tokenIn,
      tokenOut,
      amountIn: quote.estimatedAmountIn,
      amountOut: quote.estimatedAmountOut,
      price,
      slippagePct: slippagePct || 1, // Default 1% if not provided
      priceWithSlippage,
      minAmountOut: quote.minAmountOut,
      maxAmountIn: quote.maxAmountIn,
      // AMM-specific fields
      priceImpactPct,
      fee,
      computeUnits: estimatedGasValue, // Use gas limit as compute units for Ethereum
    };
  } catch (error) {
    logger.error(`Error formatting swap quote: ${error.message}`);
    if (error.stack) {
      logger.debug(`Stack trace: ${error.stack}`);
    }
    throw error;
  }
}

export const quoteSwapRoute: FastifyPluginAsync = async (fastify) => {
  // Import the httpErrors plugin to ensure it's available
  await fastify.register(require('@fastify/sensible'));

  fastify.get<{
    Querystring: QuoteSwapRequestType;
    Reply: QuoteSwapResponseType;
  }>(
    '/quote-swap',
    {
      schema: {
        description: 'Get swap quote for ETCSwap V2 AMM',
        tags: ['/connector/etcSwap'],
        querystring: {
          ...QuoteSwapRequest,
          properties: {
            ...QuoteSwapRequest.properties,
            network: { type: 'string', default: 'base' },
            baseToken: { type: 'string', examples: ['WETC'] },
            quoteToken: { type: 'string', examples: ['USC'] },
            amount: { type: 'number', examples: [0.001] },
            side: { type: 'string', enum: ['BUY', 'SELL'], examples: ['SELL'] },
            poolAddress: { type: 'string', examples: [''] },
            slippagePct: { type: 'number', examples: [1] },
          },
        },
        response: { 200: QuoteSwapResponse },
      },
    },
    async (request) => {
      try {
        const { network, poolAddress, baseToken, quoteToken, amount, side, slippagePct } = request.query;

        const networkToUse = network;

        // Validate essential parameters
        if (!baseToken || !amount || !side) {
          throw fastify.httpErrors.badRequest('baseToken, amount, and side are required');
        }

        const etcSwap = await ETCSwap.getInstance(networkToUse);

        let poolAddressToUse = poolAddress;
        let baseTokenToUse: string;
        let quoteTokenToUse: string;

        if (poolAddressToUse) {
          // Pool address provided, get pool info to determine tokens
          const poolInfo = await getETCSwapPoolInfo(poolAddressToUse, networkToUse, 'amm');
          if (!poolInfo) {
            throw fastify.httpErrors.notFound(`Pool not found: ${poolAddressToUse}`);
          }

          // Determine which token is base and which is quote based on the provided baseToken
          if (baseToken === poolInfo.baseTokenAddress) {
            baseTokenToUse = poolInfo.baseTokenAddress;
            quoteTokenToUse = poolInfo.quoteTokenAddress;
          } else if (baseToken === poolInfo.quoteTokenAddress) {
            // User specified the quote token as base, so swap them
            baseTokenToUse = poolInfo.quoteTokenAddress;
            quoteTokenToUse = poolInfo.baseTokenAddress;
          } else {
            // Try to resolve baseToken as symbol to address
            const resolvedToken = etcSwap.getTokenBySymbol(baseToken);

            if (resolvedToken) {
              if (resolvedToken.address === poolInfo.baseTokenAddress) {
                baseTokenToUse = poolInfo.baseTokenAddress;
                quoteTokenToUse = poolInfo.quoteTokenAddress;
              } else if (resolvedToken.address === poolInfo.quoteTokenAddress) {
                baseTokenToUse = poolInfo.quoteTokenAddress;
                quoteTokenToUse = poolInfo.baseTokenAddress;
              } else {
                throw fastify.httpErrors.badRequest(`Token ${baseToken} not found in pool ${poolAddressToUse}`);
              }
            } else {
              throw fastify.httpErrors.badRequest(`Token ${baseToken} not found in pool ${poolAddressToUse}`);
            }
          }
        } else {
          // No pool address provided, need quoteToken to find pool
          if (!quoteToken) {
            throw fastify.httpErrors.badRequest('quoteToken is required when poolAddress is not provided');
          }

          baseTokenToUse = baseToken;
          quoteTokenToUse = quoteToken;

          // Find pool using findDefaultPool
          poolAddressToUse = await etcSwap.findDefaultPool(baseTokenToUse, quoteTokenToUse, 'amm');

          if (!poolAddressToUse) {
            throw fastify.httpErrors.notFound(`No AMM pool found for pair ${baseTokenToUse}-${quoteTokenToUse}`);
          }
        }

        return await formatSwapQuote(
          fastify,
          networkToUse,
          poolAddress,
          baseTokenToUse,
          quoteTokenToUse,
          amount,
          side as 'BUY' | 'SELL',
          slippagePct,
        );
      } catch (e) {
        logger.error(`Error in quote-swap route: ${e.message}`);

        // If it's already a Fastify HTTP error, re-throw it
        if (e.statusCode) {
          throw e;
        }

        // Check for specific error types
        if (e.message?.includes('Insufficient liquidity')) {
          logger.error('Request error:', e);
          throw fastify.httpErrors.badRequest('Invalid request');
        }
        if (e.message?.includes('Pool not found') || e.message?.includes('No AMM pool found')) {
          logger.error('Not found error:', e);
          throw fastify.httpErrors.notFound('Resource not found');
        }
        if (e.message?.includes('token not found')) {
          logger.error('Request error:', e);
          throw fastify.httpErrors.badRequest('Invalid request');
        }

        // Default to internal server error
        logger.error('Unexpected error getting swap quote:', e);
        throw fastify.httpErrors.internalServerError('Error getting swap quote');
      }
    },
  );
};

export default quoteSwapRoute;
