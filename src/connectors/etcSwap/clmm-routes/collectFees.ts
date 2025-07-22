import { CurrencyAmount } from '@_etcswap/sdk-core';
import { NonfungiblePositionManager } from '@_etcswap/v3-sdk';
import { Contract } from '@ethersproject/contracts';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  CollectFeesRequestType,
  CollectFeesRequest,
  CollectFeesResponseType,
  CollectFeesResponse,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { ETCSwap } from '../etcSwap';
import { POSITION_MANAGER_ABI, getETCSwapV3NftManagerAddress } from '../etcSwap.contracts';
import { formatTokenAmount } from '../etcSwap.utils';

export const collectFeesRoute: FastifyPluginAsync = async (fastify) => {
  await fastify.register(require('@fastify/sensible'));
  const walletAddressExample = await Ethereum.getWalletAddressExample();

  fastify.post<{
    Body: CollectFeesRequestType;
    Reply: CollectFeesResponseType;
  }>(
    '/collect-fees',
    {
      schema: {
        description: 'Collect fees from a ETCSwap V3 position',
        tags: ['/connector/etcSwap'],
        body: {
          ...CollectFeesRequest,
          properties: {
            ...CollectFeesRequest.properties,
            network: { type: 'string', default: 'base' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
            positionAddress: {
              type: 'string',
              description: 'Position NFT token ID',
              examples: ['1234'],
            },
          },
        },
        response: {
          200: CollectFeesResponse,
        },
      },
    },
    async (request) => {
      try {
        const {
          network,
          walletAddress: requestedWalletAddress,
          positionAddress,
          priorityFeePerCU,
          computeUnits,
        } = request.body;

        const networkToUse = network;

        // Validate essential parameters
        if (!positionAddress) {
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

        // Check NFT ownership
        try {
          await etcSwap.checkNFTOwnership(positionAddress, walletAddress);
        } catch (error: any) {
          if (error.message.includes('is not owned by')) {
            throw fastify.httpErrors.forbidden(error.message);
          }
          throw fastify.httpErrors.badRequest(error.message);
        }

        // Create position manager contract
        const positionManager = new Contract(positionManagerAddress, POSITION_MANAGER_ABI, wallet);

        // Get position details
        const position = await positionManager.positions(positionAddress);

        // Get tokens by address
        const token0 = etcSwap.getTokenByAddress(position.token0);
        const token1 = etcSwap.getTokenByAddress(position.token1);

        // Determine base and quote tokens - WETC or lower address is base
        const isBaseToken0 =
          token0.symbol === 'WETC' ||
          (token1.symbol !== 'WETC' && token0.address.toLowerCase() < token1.address.toLowerCase());

        // Get fees owned
        const feeAmount0 = position.tokensOwed0;
        const feeAmount1 = position.tokensOwed1;

        // If no fees to collect, throw an error
        if (feeAmount0.eq(0) && feeAmount1.eq(0)) {
          throw fastify.httpErrors.badRequest('No fees to collect');
        }

        // Create CurrencyAmount objects for fees
        const expectedCurrencyOwed0 = CurrencyAmount.fromRawAmount(token0, feeAmount0.toString());
        const expectedCurrencyOwed1 = CurrencyAmount.fromRawAmount(token1, feeAmount1.toString());

        // Create parameters for collecting fees
        const collectParams = {
          tokenId: positionAddress,
          expectedCurrencyOwed0,
          expectedCurrencyOwed1,
          recipient: walletAddress,
        };

        // Get calldata for collecting fees
        const { calldata, value } = NonfungiblePositionManager.collectCallParameters(collectParams);

        // Execute the transaction to collect fees
        // Use Ethereum's prepareGasOptions method
        const txParams = await ethereum.prepareGasOptions(priorityFeePerCU, computeUnits || 300000);
        txParams.value = BigNumber.from(value.toString());

        const tx = await positionManager.multicall([calldata], txParams);
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
        throw fastify.httpErrors.internalServerError('Failed to collect fees');
      }
    },
  );
};

export default collectFeesRoute;
