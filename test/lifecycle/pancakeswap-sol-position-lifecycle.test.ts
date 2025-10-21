/**
 * PancakeSwap Solana CLMM Position Lifecycle Integration Test
 *
 * Executes the full lifecycle of a CLMM position on Solana mainnet-beta:
 * 1. Open position with initial liquidity → Signs and sends transaction
 * 2. Add liquidity (50% of original) → Signs and sends transaction
 * 3. Remove liquidity (50% of current) → Signs and sends transaction
 * 4. Close position (removes remaining liquidity and burns NFT) → Signs and sends transaction
 *
 * ⚠️  WARNING: This is a LIVE integration test that executes REAL transactions on-chain!
 * Each step waits for transaction confirmation before proceeding to the next.
 *
 * Requirements:
 * - Wallet configured in conf/wallets/solana/
 * - Sufficient SOL for transaction fees (~0.02-0.05 SOL total)
 * - Sufficient PENGU and USDC tokens for the position
 * - Gateway passphrase to decrypt wallet
 *
 * Run in one line:
 * GATEWAY_TEST_MODE=dev MANUAL_TEST=true GATEWAY_PASSPHRASE=<your_passphrase> jest --runInBand test/lifecycle/pancakeswap-sol-position-lifecycle.test.ts
 */

// ============================================================================
// TEST CONFIGURATION - Customize these values
// ============================================================================

const TEST_CONFIG = {
  network: 'mainnet-beta',
  walletAddress: '82SggYRE2Vo4jN4a2pk3aQ4SET4ctafZJGbowmCqyHx5',

  // PENGU/USDC Pool on PancakeSwap Solana
  poolAddress: 'CbvdQYoaykHHQ9k27W7WCEMJL8jY99NZ7FoNPfa2vEVx',

  // Initial position parameters
  lowerPrice: 0.02, // Lower price bound
  upperPrice: 0.025, // Upper price bound
  baseTokenAmount: 10, // Initial base token amount (PENGU)
  quoteTokenAmount: 0.25, // Initial quote token amount (USDC)
  slippagePct: 1, // Slippage tolerance (1%)

  // Liquidity modification percentages
  addLiquidityPct: 50, // Add 50% more liquidity
  removeLiquidityPct: 50, // Remove 50% of liquidity
};

// ============================================================================
// TEST IMPLEMENTATION
// ============================================================================

import { Solana } from '../../src/chains/solana/solana';
import { PancakeswapSol } from '../../src/connectors/pancakeswap-sol/pancakeswap-sol';

let solana: Solana;
let pancakeswapSol: PancakeswapSol;
let positionAddress: string;

/**
 * Position Lifecycle Integration Test
 *
 * IMPORTANT: This test is SKIPPED by default and should be run manually by QA users.
 *
 * Requirements:
 * - GATEWAY_TEST_MODE=dev environment variable
 * - MANUAL_TEST=true environment variable to enable this test
 * - GATEWAY_PASSPHRASE environment variable to decrypt wallet
 * - Wallet configured in conf/wallets/solana/
 * - Sufficient SOL for transaction fees (~0.02-0.05 SOL)
 * - Sufficient PENGU and USDC tokens for the position
 *
 * Run with:
 * GATEWAY_TEST_MODE=dev MANUAL_TEST=true GATEWAY_PASSPHRASE=<your_passphrase> jest --runInBand test/lifecycle/pancakeswap-sol-position-lifecycle.test.ts
 */
const describeTest = process.env.MANUAL_TEST === 'true' ? describe : describe.skip;

describeTest('PancakeSwap Solana CLMM Position Lifecycle - MANUAL TEST', () => {
  beforeAll(async () => {
    solana = await Solana.getInstance(TEST_CONFIG.network);
    pancakeswapSol = await PancakeswapSol.getInstance(TEST_CONFIG.network);
  });

  // ==========================================================================
  // Step 1: Open Position
  // ==========================================================================

  it('should open a new CLMM position', async () => {
    console.log('\n=== Step 1: Opening CLMM Position ===');
    console.log(`Pool: ${TEST_CONFIG.poolAddress}`);
    console.log(`Price Range: ${TEST_CONFIG.lowerPrice} - ${TEST_CONFIG.upperPrice}`);
    console.log(`Initial Amounts: ${TEST_CONFIG.baseTokenAmount} base, ${TEST_CONFIG.quoteTokenAmount} quote`);

    // Import openPosition route function
    const { openPosition } = await import('../../src/connectors/pancakeswap-sol/clmm-routes/openPosition');

    // Create mock fastify instance
    const mockFastify = {
      httpErrors: {
        notFound: (msg: string) => new Error(msg),
        badRequest: (msg: string) => new Error(msg),
        internalServerError: (msg: string) => new Error(msg),
      },
    };

    // Call the route function directly
    const result = await openPosition(
      mockFastify as any,
      TEST_CONFIG.network,
      TEST_CONFIG.walletAddress,
      TEST_CONFIG.poolAddress,
      TEST_CONFIG.lowerPrice,
      TEST_CONFIG.upperPrice,
      TEST_CONFIG.baseTokenAmount,
      TEST_CONFIG.quoteTokenAmount,
      TEST_CONFIG.slippagePct,
    );

    expect(result.status).toBe(1); // CONFIRMED
    expect(result.signature).toBeTruthy();
    expect(result.data).toBeTruthy();

    // Save position address for next steps
    positionAddress = result.data!.positionAddress;

    console.log(`\n✅ Position opened successfully!`);
    console.log(`   Signature: ${result.signature}`);
    console.log(`   Fee: ${result.data!.fee.toFixed(6)} SOL`);
    console.log(`   Position NFT: ${positionAddress}`);
    console.log(`   Base added: ${result.data!.baseTokenAmountAdded.toFixed(6)}`);
    console.log(`   Quote added: ${result.data!.quoteTokenAmountAdded.toFixed(6)}`);
  }, 120000);

  // ==========================================================================
  // Step 2: Add Liquidity (50% of original)
  // ==========================================================================

  it('should add liquidity to the position (50% of original)', async () => {
    console.log('\n=== Step 2: Adding Liquidity ===');
    console.log(`Position: ${positionAddress}`);

    // Calculate amounts to add (50% of original)
    const addBaseAmount = TEST_CONFIG.baseTokenAmount * (TEST_CONFIG.addLiquidityPct / 100);
    const addQuoteAmount = TEST_CONFIG.quoteTokenAmount * (TEST_CONFIG.addLiquidityPct / 100);

    console.log(`Adding: ${addBaseAmount} base (${TEST_CONFIG.addLiquidityPct}% of original)`);
    console.log(`Adding: ${addQuoteAmount} quote (${TEST_CONFIG.addLiquidityPct}% of original)`);

    // Import addLiquidity route function
    const { addLiquidity } = await import('../../src/connectors/pancakeswap-sol/clmm-routes/addLiquidity');

    // Create mock fastify instance
    const mockFastify = {
      httpErrors: {
        notFound: (msg: string) => new Error(msg),
        badRequest: (msg: string) => new Error(msg),
        internalServerError: (msg: string) => new Error(msg),
      },
    };

    // Call the route function
    const result = await addLiquidity(
      mockFastify as any,
      TEST_CONFIG.network,
      TEST_CONFIG.walletAddress,
      positionAddress,
      addBaseAmount,
      addQuoteAmount,
      TEST_CONFIG.slippagePct,
    );

    expect(result.status).toBe(1); // CONFIRMED
    expect(result.signature).toBeTruthy();
    expect(result.data).toBeTruthy();

    console.log(`\n✅ Liquidity added successfully!`);
    console.log(`   Signature: ${result.signature}`);
    console.log(`   Fee: ${result.data!.fee.toFixed(6)} SOL`);
    console.log(`   Base added: ${result.data!.baseTokenAmountAdded.toFixed(6)}`);
    console.log(`   Quote added: ${result.data!.quoteTokenAmountAdded.toFixed(6)}`);
  }, 120000);

  // ==========================================================================
  // Step 3: Remove Liquidity (50% of current)
  // ==========================================================================

  it('should remove liquidity from the position (50% of current)', async () => {
    console.log('\n=== Step 3: Removing Liquidity ===');
    console.log(`Position: ${positionAddress}`);
    console.log(`Removing: ${TEST_CONFIG.removeLiquidityPct}% of current liquidity`);

    // Import removeLiquidity route function
    const { removeLiquidity } = await import('../../src/connectors/pancakeswap-sol/clmm-routes/removeLiquidity');

    // Create mock fastify instance
    const mockFastify = {
      httpErrors: {
        notFound: (msg: string) => new Error(msg),
        badRequest: (msg: string) => new Error(msg),
        internalServerError: (msg: string) => new Error(msg),
      },
    };

    // Call the route function
    const result = await removeLiquidity(
      mockFastify as any,
      TEST_CONFIG.network,
      TEST_CONFIG.walletAddress,
      positionAddress,
      TEST_CONFIG.removeLiquidityPct,
    );

    expect(result.status).toBe(1); // CONFIRMED
    expect(result.signature).toBeTruthy();
    expect(result.data).toBeTruthy();

    console.log(`\n✅ Liquidity removed successfully!`);
    console.log(`   Signature: ${result.signature}`);
    console.log(`   Fee: ${result.data!.fee.toFixed(6)} SOL`);
    console.log(`   Base removed: ${result.data!.baseTokenAmountRemoved.toFixed(6)}`);
    console.log(`   Quote removed: ${result.data!.quoteTokenAmountRemoved.toFixed(6)}`);
  }, 120000);

  // ==========================================================================
  // Step 4: Close Position
  // ==========================================================================

  it('should close the position and burn NFT', async () => {
    console.log('\n=== Step 4: Closing Position ===');
    console.log(`Position: ${positionAddress}`);
    console.log(`This will remove all remaining liquidity and burn the position NFT`);

    // Import closePosition route function
    const { closePosition } = await import('../../src/connectors/pancakeswap-sol/clmm-routes/closePosition');

    // Create mock fastify instance
    const mockFastify = {
      httpErrors: {
        notFound: (msg: string) => new Error(msg),
        badRequest: (msg: string) => new Error(msg),
        internalServerError: (msg: string) => new Error(msg),
      },
    };

    // Call the route function (automatically removes remaining liquidity)
    const result = await closePosition(
      mockFastify as any,
      TEST_CONFIG.network,
      TEST_CONFIG.walletAddress,
      positionAddress,
    );

    expect(result.status).toBe(1); // CONFIRMED
    expect(result.signature).toBeTruthy();
    expect(result.data).toBeTruthy();

    console.log(`\n✅ Position closed successfully!`);
    console.log(`   Signature: ${result.signature}`);
    console.log(`   Fee: ${result.data!.fee.toFixed(6)} SOL`);
    console.log(`   NFT burned: ${positionAddress}`);
    if (result.data!.baseTokenAmountRemoved > 0 || result.data!.quoteTokenAmountRemoved > 0) {
      console.log(`   Final liquidity removed:`);
      console.log(`     Base: ${result.data!.baseTokenAmountRemoved.toFixed(6)}`);
      console.log(`     Quote: ${result.data!.quoteTokenAmountRemoved.toFixed(6)}`);
    }
  }, 120000);

  // ==========================================================================
  // Summary
  // ==========================================================================

  afterAll(() => {
    console.log('\n=== Position Lifecycle Test Summary ===');
    console.log(`✅ Successfully executed full position lifecycle on-chain:`);
    console.log(
      `   1. ✅ Opened position with ${TEST_CONFIG.baseTokenAmount} base, ${TEST_CONFIG.quoteTokenAmount} quote`,
    );
    console.log(`   2. ✅ Added ${TEST_CONFIG.addLiquidityPct}% more liquidity`);
    console.log(`   3. ✅ Removed ${TEST_CONFIG.removeLiquidityPct}% of liquidity`);
    console.log(`   4. ✅ Closed position and burned NFT`);
    console.log(`\n📋 Details:`);
    console.log(`   Network: ${TEST_CONFIG.network}`);
    console.log(`   Pool: ${TEST_CONFIG.poolAddress}`);
    console.log(`   Position NFT: ${positionAddress}`);
    console.log(`\n⚠️  Check Solana Explorer for full transaction details`);
  });
});
