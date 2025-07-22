import { CurrencyAmount, Percent } from '@_etcswap/sdk-core';
import { Position, NonfungiblePositionManager } from '@_etcswap/v3-sdk';
import { Contract } from '@ethersproject/contracts';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  AddLiquidityRequestType,
  AddLiquidityRequest,
  AddLiquidityResponseType,
  AddLiquidityResponse,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { ETCSwap } from '../etcSwap';
import { getETCSwapV3NftManagerAddress, POSITION_MANAGER_ABI } from '../etcSwap.contracts';
import { formatTokenAmount } from '../etcSwap.utils';

export const addLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: AddLiquidityRequestType;
    Reply: AddLiquidityResponseType;
  }>(
    '/add-liquidity',
    {
      schema: {
        description: 'Add liquidity to an existing ETCSwap V3 position',
        tags: ['/connector/etcSwap'],
        body: {
          ...AddLiquidityRequest,
          properties: {
            ...AddLiquidityRequest.properties,
            network: { type: 'string', default: 'base' },
            walletAddress: { type: 'string', examples: ['0x...'] },
            positionAddress: {
              type: 'string',
              description: 'Position NFT token ID',
            },
            baseTokenAmount: { type: 'number', examples: [0.1] },
            quoteTokenAmount: { type: 'number', examples: [200] },
            slippagePct: { type: 'number', examples: [1] },
          },
        },
        response: {
          200: AddLiquidityResponse,
        },
      },
    },
    async (request) => {
      try {
        const {
          network,
          walletAddress: requestedWalletAddress,
          positionAddress,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
          priorityFeePerCU,
          computeUnits,
        } = request.body;

        const networkToUse = network;

        // Validate essential parameters
        if (!positionAddress || (baseTokenAmount === undefined && quoteTokenAmount === undefined)) {
          throw fastify.httpErrors.badRequest('Missing required parameters');
        }

        // Get ETCSwap and Ethereum instances
        const etcSwap = await ETCSwap.getInstance(networkToUse);
        const ethereum = await Ethereum.getInstance(networkToUse);

        // Get wallet address - either from request or first available
        let walletAddress = requestedWalletAddress;
        if (!walletAddress) {
          walletAddress = await etcSwap.getFirstWalletAddress();
          if (!walletAddress) {
            throw fastify.httpErrors.badRequest('No wallet address provided and no default wallet found');
          }
          logger.info(`Using first available wallet address: ${walletAddress}`);
        }

        // Get the wallet
        const wallet = await ethereum.getWallet(walletAddress);
        if (!wallet) {
          throw fastify.httpErrors.badRequest('Wallet not found');
        }

        // Get position manager address
        const positionManagerAddress = getETCSwapV3NftManagerAddress(networkToUse);

        // Create position manager contract
        const positionManager = new Contract(positionManagerAddress, POSITION_MANAGER_ABI, ethereum.provider);

        // Get position details
        const position = await positionManager.positions(positionAddress);

        // Get tokens by address
        const token0 = etcSwap.getTokenByAddress(position.token0);
        const token1 = etcSwap.getTokenByAddress(position.token1);
        const fee = position.fee;
        const tickLower = position.tickLower;
        const tickUpper = position.tickUpper;

        // Get the pool
        const pool = await etcSwap.getV3Pool(token0, token1, fee);
        if (!pool) {
          throw fastify.httpErrors.notFound('Pool not found for position');
        }

        // Calculate slippage tolerance
        // Convert slippagePct to integer basis points (0.5% -> 50 basis points)
        const slippageTolerance = new Percent(Math.floor((slippagePct ?? etcSwap.config.slippagePct) * 100), 10000);

        // Determine base and quote tokens
        const baseTokenSymbol = token0.symbol === 'WETC' ? token0.symbol : token1.symbol;
        const isBaseToken0 = token0.symbol === baseTokenSymbol;

        // Calculate token amounts to add
        let token0Amount = CurrencyAmount.fromRawAmount(token0, 0);
        let token1Amount = CurrencyAmount.fromRawAmount(token1, 0);

        if (baseTokenAmount !== undefined) {
          // Convert baseTokenAmount to raw amount
          const baseAmountRaw = Math.floor(
            baseTokenAmount * Math.pow(10, isBaseToken0 ? token0.decimals : token1.decimals),
          );

          if (isBaseToken0) {
            token0Amount = CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(baseAmountRaw.toString()));
          } else {
            token1Amount = CurrencyAmount.fromRawAmount(token1, JSBI.BigInt(baseAmountRaw.toString()));
          }
        }

        if (quoteTokenAmount !== undefined) {
          // Convert quoteTokenAmount to raw amount
          const quoteAmountRaw = Math.floor(
            quoteTokenAmount * Math.pow(10, isBaseToken0 ? token1.decimals : token0.decimals),
          );

          if (isBaseToken0) {
            token1Amount = CurrencyAmount.fromRawAmount(token1, JSBI.BigInt(quoteAmountRaw.toString()));
          } else {
            token0Amount = CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(quoteAmountRaw.toString()));
          }
        }

        // Create a new Position to represent the added liquidity
        const newPosition = Position.fromAmounts({
          pool,
          tickLower,
          tickUpper,
          amount0: token0Amount.quotient,
          amount1: token1Amount.quotient,
          useFullPrecision: true,
        });

        // Create increase liquidity options
        const increaseLiquidityOptions = {
          tokenId: positionAddress,
          slippageTolerance,
          deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes from now
        };

        // Get calldata for increasing liquidity
        const { calldata, value } = NonfungiblePositionManager.addCallParameters(newPosition, increaseLiquidityOptions);

        // Check allowances instead of approving
        // Check token0 allowance if needed
        if (!token0Amount.equalTo(0) && token0.symbol !== 'WETC') {
          const token0Contract = ethereum.getContract(token0.address, wallet);
          const allowance0 = await ethereum.getERC20Allowance(
            token0Contract,
            wallet,
            positionManagerAddress,
            token0.decimals,
          );

          const currentAllowance0 = BigNumber.from(allowance0.value);
          const requiredAmount0 = BigNumber.from(token0Amount.quotient.toString());

          if (currentAllowance0.lt(requiredAmount0)) {
            throw fastify.httpErrors.badRequest(
              `Insufficient ${token0.symbol} allowance. Please approve at least ${formatTokenAmount(requiredAmount0.toString(), token0.decimals)} ${token0.symbol} for the Position Manager (${positionManagerAddress})`,
            );
          }
        }

        // Check token1 allowance if needed
        if (!token1Amount.equalTo(0) && token1.symbol !== 'WETC') {
          const token1Contract = ethereum.getContract(token1.address, wallet);
          const allowance1 = await ethereum.getERC20Allowance(
            token1Contract,
            wallet,
            positionManagerAddress,
            token1.decimals,
          );

          const currentAllowance1 = BigNumber.from(allowance1.value);
          const requiredAmount1 = BigNumber.from(token1Amount.quotient.toString());

          if (currentAllowance1.lt(requiredAmount1)) {
            throw fastify.httpErrors.badRequest(
              `Insufficient ${token1.symbol} allowance. Please approve at least ${formatTokenAmount(requiredAmount1.toString(), token1.decimals)} ${token1.symbol} for the Position Manager (${positionManagerAddress})`,
            );
          }
        }

        // Initialize position manager with multicall interface
        const positionManagerWithSigner = new Contract(
          positionManagerAddress,
          [
            {
              inputs: [{ internalType: 'bytes[]', name: 'data', type: 'bytes[]' }],
              name: 'multicall',
              outputs: [{ internalType: 'bytes[]', name: 'results', type: 'bytes[]' }],
              stateMutability: 'payable',
              type: 'function',
            },
          ],
          wallet,
        );

        // Execute the transaction to increase liquidity
        // Use Ethereum's prepareGasOptions method
        const txParams = await ethereum.prepareGasOptions(priorityFeePerCU, computeUnits);
        txParams.value = BigNumber.from(value.toString());

        const tx = await positionManagerWithSigner.multicall([calldata], txParams);

        return {
          signature: tx.hash,
          status: 0, // UNCONFIRMED
          data: undefined,
        };
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw e;
        }
        throw fastify.httpErrors.internalServerError('Failed to add liquidity');
      }
    },
  );
};

export default addLiquidityRoute;
