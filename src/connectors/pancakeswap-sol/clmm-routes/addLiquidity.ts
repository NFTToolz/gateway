import { Static } from '@sinclair/typebox';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import { AddLiquidityResponse, AddLiquidityResponseType } from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { PancakeswapSol } from '../pancakeswap-sol';
import { buildAddLiquidityTransaction } from '../pancakeswap-sol-utils';
import { PancakeswapSolClmmAddLiquidityRequest } from '../schemas';

import { quotePosition } from './quotePosition';

async function addLiquidity(
  _fastify: FastifyInstance,
  network: string,
  walletAddress: string,
  positionAddress: string,
  baseTokenAmount: number,
  quoteTokenAmount: number,
  slippagePct?: number,
): Promise<AddLiquidityResponseType> {
  const solana = await Solana.getInstance(network);
  const pancakeswapSol = await PancakeswapSol.getInstance(network);

  // Get position info
  const positionInfo = await pancakeswapSol.getPositionInfo(positionAddress);
  if (!positionInfo) {
    throw _fastify.httpErrors.notFound(`Position not found: ${positionAddress}`);
  }

  const wallet = await solana.getWallet(walletAddress);
  const walletPubkey = new PublicKey(walletAddress);
  const positionNftMint = new PublicKey(positionAddress);

  // Get token info
  const baseToken = await solana.getToken(positionInfo.baseTokenAddress);
  const quoteToken = await solana.getToken(positionInfo.quoteTokenAddress);

  if (!baseToken || !quoteToken) {
    throw _fastify.httpErrors.notFound('Token information not found');
  }

  // Get quote for position amounts (same as Raydium approach)
  // This calculates proper amounts based on position's tick range and current pool price
  const quote = await quotePosition(
    _fastify,
    network,
    positionInfo.lowerPrice,
    positionInfo.upperPrice,
    positionInfo.poolAddress,
    baseTokenAmount,
    quoteTokenAmount,
  );

  logger.info(
    `Adding liquidity to position ${positionAddress}: ${baseTokenAmount} ${baseToken.symbol}, ${quoteTokenAmount} ${quoteToken.symbol}`,
  );
  logger.info(
    `Quote: baseLimited=${quote.baseLimited}, base=${quote.baseTokenAmount}, quote=${quote.quoteTokenAmount}`,
  );
  logger.info(`Quote Max: base=${quote.baseTokenAmountMax}, quote=${quote.quoteTokenAmountMax}`);

  // Apply slippage buffer (same as openPosition and Raydium)
  const effectiveSlippage = slippagePct || 1.0;
  const amount0Max = new BN(
    (quote.baseTokenAmountMax * (1 + effectiveSlippage / 100) * 10 ** baseToken.decimals).toFixed(0),
  );
  const amount1Max = new BN(
    (quote.quoteTokenAmountMax * (1 + effectiveSlippage / 100) * 10 ** quoteToken.decimals).toFixed(0),
  );

  // Use quote result to determine base flag (same as Raydium)
  const baseFlag = quote.baseLimited;

  logger.info(`Amounts with slippage (${effectiveSlippage}%):`);
  logger.info(`  amount0Max: ${amount0Max.toString()} (${baseToken.symbol})`);
  logger.info(`  amount1Max: ${amount1Max.toString()} (${quoteToken.symbol})`);
  logger.info(`Base Flag: ${baseFlag}`);

  // Get priority fee
  const priorityFeeInLamports = await solana.estimateGasPrice();
  const priorityFeePerCU = Math.floor(priorityFeeInLamports * 1e6);

  // Build transaction
  const transaction = await buildAddLiquidityTransaction(
    solana,
    positionNftMint,
    walletPubkey,
    amount0Max,
    amount1Max,
    baseFlag,
    600000,
    priorityFeePerCU,
  );

  // Sign and send
  transaction.sign([wallet]);
  await solana.simulateWithErrorHandling(transaction, _fastify);

  const { confirmed, signature, txData } = await solana.sendAndConfirmRawTransaction(transaction);

  if (confirmed && txData) {
    const totalFee = txData.meta.fee;

    // Extract balance changes
    const { balanceChanges } = await solana.extractBalanceChangesAndFee(signature, walletAddress, [
      baseToken.address,
      quoteToken.address,
    ]);

    const baseTokenChange = balanceChanges[0];
    const quoteTokenChange = balanceChanges[1];

    logger.info(`Liquidity added successfully. Signature: ${signature}`);
    logger.info(
      `Added ${Math.abs(baseTokenChange).toFixed(4)} ${baseToken.symbol}, ${Math.abs(quoteTokenChange).toFixed(4)} ${quoteToken.symbol}`,
    );

    return {
      signature,
      status: 1, // CONFIRMED
      data: {
        fee: totalFee / 1e9,
        baseTokenAmountAdded: Math.abs(baseTokenChange),
        quoteTokenAmountAdded: Math.abs(quoteTokenChange),
      },
    };
  }

  return {
    signature,
    status: 0, // PENDING
  };
}

export const addLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: Static<typeof PancakeswapSolClmmAddLiquidityRequest>;
    Reply: AddLiquidityResponseType;
  }>(
    '/add-liquidity',
    {
      schema: {
        description: 'Add liquidity to an existing PancakeSwap Solana CLMM position',
        tags: ['/connector/pancakeswap-sol'],
        body: PancakeswapSolClmmAddLiquidityRequest,
        response: {
          200: AddLiquidityResponse,
        },
      },
    },
    async (request) => {
      try {
        const {
          network = 'mainnet-beta',
          walletAddress,
          positionAddress,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
        } = request.body;

        return await addLiquidity(
          fastify,
          network,
          walletAddress!,
          positionAddress,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
        );
      } catch (e: any) {
        logger.error('Add liquidity error:', e);
        // Re-throw httpErrors as-is
        if (e.statusCode) {
          throw e;
        }
        // Handle unknown errors
        const errorMessage = e.message || 'Failed to add liquidity';
        throw fastify.httpErrors.internalServerError(errorMessage);
      }
    },
  );
};

export default addLiquidityRoute;
