import crypto from 'crypto';

import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getMint,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import { TokenInfo } from '@solana/spl-token-registry';
import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  MessageV0,
  Signer,
  Transaction,
  TransactionResponse,
  VersionedTransaction,
  VersionedTransactionResponse,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import fse from 'fs-extra';

// TODO: Replace with Fastify httpErrors
const SIMULATION_ERROR_MESSAGE = 'Transaction simulation failed: ';

import { ConfigManagerCertPassphrase } from '../../services/config-manager-cert-passphrase';
import { ConfigManagerV2 } from '../../services/config-manager-v2';
import { logger } from '../../services/logger';
import { TokenService } from '../../services/token-service';
import { getSafeWalletFilePath, isHardwareWallet as isHardwareWalletUtil } from '../../wallet/utils';

import { HeliusService } from './helius-service';
import { SolanaPriorityFees } from './solana-priority-fees';
import { SolanaNetworkConfig, getSolanaNetworkConfig, getSolanaChainConfig } from './solana.config';

// Constants used for fee calculations
export const BASE_FEE = 5000;
const LAMPORT_TO_SOL = 1 / Math.pow(10, 9);

// Jito tip accounts for bundles
const JITO_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWkcJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];

// Interface for token account data
interface TokenAccount {
  parsedAccount: any;
  value: any;
}

enum TransactionResponseStatusCode {
  FAILED = -1,
  UNCONFIRMED = 0,
  CONFIRMED = 1,
}

export class Solana {
  public connection: Connection;
  public network: string;
  public nativeTokenSymbol: string;

  public tokenList: TokenInfo[] = [];
  public config: SolanaNetworkConfig;
  private _tokenMap: Record<string, TokenInfo> = {};
  private heliusService: HeliusService;
  private heliusConfig: { useHeliusSender?: boolean; jitoTipSOL?: number } = {};

  private static _instances: { [name: string]: Solana };

  private constructor(network: string) {
    this.network = network;
    this.config = getSolanaNetworkConfig(network);
    this.nativeTokenSymbol = this.config.nativeCurrencySymbol;

    // Get rpcProvider from chain config
    const chainConfig = getSolanaChainConfig();
    const rpcProvider = chainConfig.rpcProvider || 'url';

    // Initialize RPC connection based on provider
    if (rpcProvider === 'helius') {
      logger.info(`Initializing Helius services for provider: ${rpcProvider}`);
      this.initializeHeliusProvider();
    } else {
      // Default: use nodeURL
      logger.info(`Using standard RPC provider: ${rpcProvider}`);
      logger.info(`Initializing Solana connector for network: ${this.network}, RPC URL: ${this.config.nodeURL}`);
      this.connection = new Connection(this.config.nodeURL, {
        commitment: 'confirmed',
      });
    }
  }

  /**
   * Initialize Helius RPC provider
   */
  private initializeHeliusProvider() {
    try {
      // Load Helius config from rpc/helius.yml
      const configManager = ConfigManagerV2.getInstance();
      const heliusApiKey = configManager.get('helius.apiKey') || '';
      const useWebSocketRPC = configManager.get('helius.useWebSocketRPC') || false;
      const useSender = configManager.get('helius.useSender') || false;
      const regionCode = configManager.get('helius.regionCode') || '';
      const jitoTipSOL = configManager.get('helius.jitoTipSOL') || 0;

      // Store Helius-specific config
      this.heliusConfig = {
        useHeliusSender: useSender,
        jitoTipSOL: jitoTipSOL,
      };

      // Merge configs for HeliusService
      const mergedConfig = {
        ...this.config,
        heliusAPIKey: heliusApiKey,
        useHeliusRestRPC: true, // Always true when using Helius provider
        useHeliusWebSocketRPC: useWebSocketRPC,
        useHeliusSender: useSender,
        heliusRegionCode: regionCode,
        jitoTipSOL: jitoTipSOL,
      };

      // Always use Helius RPC URL when Helius provider is selected
      if (heliusApiKey && heliusApiKey.trim() !== '') {
        const rpcUrl = this.network.includes('devnet')
          ? `https://devnet.helius-rpc.com/?api-key=${heliusApiKey}`
          : `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;

        logger.info(`Initializing Solana connector for network: ${this.network}, RPC URL: ${rpcUrl}`);
        logger.info(`✅ Helius API key configured (length: ${heliusApiKey.length} chars)`);
        logger.info(
          `Helius features enabled - WebSocket: ${useWebSocketRPC}, Sender: ${useSender}, Region: ${regionCode || 'default'}`,
        );

        this.connection = new Connection(rpcUrl, {
          commitment: 'confirmed',
        });
      } else {
        // Fallback to standard nodeURL if no API key
        logger.warn(`⚠️ Helius provider selected but no API key configured, falling back to standard RPC`);
        logger.info(`Using fallback RPC URL: ${this.config.nodeURL}`);
        this.connection = new Connection(this.config.nodeURL, {
          commitment: 'confirmed',
        });
      }

      // Initialize HeliusService with merged config
      this.heliusService = new HeliusService(mergedConfig);
    } catch (error) {
      // If Helius config not found (e.g., in tests), fallback to standard RPC
      logger.warn(`Failed to initialize Helius provider: ${error.message}, falling back to standard RPC`);
      this.connection = new Connection(this.config.nodeURL, {
        commitment: 'confirmed',
      });
    }
  }

  public static async getInstance(network: string): Promise<Solana> {
    if (!Solana._instances) {
      Solana._instances = {};
    }
    if (!Solana._instances[network]) {
      const instance = new Solana(network);
      await instance.init();
      Solana._instances[network] = instance;
    }
    return Solana._instances[network];
  }

  private async init(): Promise<void> {
    try {
      logger.info(
        `Initializing Solana connector for network: ${this.network}, RPC URL: ${this.connection.rpcEndpoint}`,
      );
      await this.loadTokens();

      // Initialize Helius services only if using Helius provider
      const chainConfig = getSolanaChainConfig();
      const rpcProvider = chainConfig.rpcProvider || 'url';
      if (rpcProvider === 'helius' && this.heliusService) {
        logger.info(`Initializing Helius services for provider: ${rpcProvider}`);
        await this.heliusService.initialize();
      } else {
        logger.info(`Using standard RPC provider: ${rpcProvider}`);
      }
    } catch (e) {
      logger.error(`Failed to initialize ${this.network}: ${e}`);
      throw e;
    }
  }

  async getTokenList(): Promise<TokenInfo[]> {
    // Always return the stored list loaded via TokenService
    return this.tokenList;
  }

  async loadTokens(): Promise<void> {
    try {
      // Use TokenService to load tokens
      const tokens = await TokenService.getInstance().loadTokenList('solana', this.network);

      // Convert to TokenInfo format (SPL token registry format)
      this.tokenList = tokens.map((token) => ({
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        chainId: 101, // Solana mainnet chainId
      }));

      // Create symbol -> token mapping
      this.tokenList.forEach((token: TokenInfo) => {
        this._tokenMap[token.symbol] = token;
      });

      logger.info(`Loaded ${this.tokenList.length} tokens for solana/${this.network}`);
    } catch (error) {
      logger.error(`Failed to load token list for ${this.network}: ${error.message}`);
      throw error;
    }
  }

  async getToken(addressOrSymbol: string): Promise<TokenInfo | null> {
    // First try to find by symbol (case-insensitive)
    const normalizedSearch = addressOrSymbol.toUpperCase().trim();
    let token = this.tokenList.find((token: TokenInfo) => token.symbol.toUpperCase().trim() === normalizedSearch);

    // If not found by symbol, try to find by address
    if (!token) {
      token = this.tokenList.find((token: TokenInfo) => token.address.toLowerCase() === addressOrSymbol.toLowerCase());
    }

    // If still not found, try to create a new token assuming addressOrSymbol is an address
    if (!token) {
      try {
        // Validate if it's a valid public key
        const mintPubkey = new PublicKey(addressOrSymbol);

        // Fetch mint info to get decimals
        const mintInfo = await getMint(this.connection, mintPubkey);

        // Create a basic token object with fetched decimals
        token = {
          address: addressOrSymbol,
          symbol: `DUMMY_${addressOrSymbol.slice(0, 4)}`,
          name: `Dummy Token (${addressOrSymbol.slice(0, 8)}...)`,
          decimals: mintInfo.decimals,
          chainId: 101,
        };
      } catch (e) {
        // Not a valid public key or couldn't fetch mint info, return null
        return null;
      }
    }

    return token;
  }

  // returns Keypair for a private key, which should be encoded in Base58
  getKeypairFromPrivateKey(privateKey: string): Keypair {
    const decoded = bs58.decode(privateKey);
    return Keypair.fromSecretKey(new Uint8Array(decoded));
  }

  /**
   * Validate Solana address format
   * @param address The address to validate
   * @returns The address if valid
   * @throws Error if the address is invalid
   */
  public static validateAddress(address: string): string {
    try {
      // Check if address can be parsed as a public key
      new PublicKey(address);

      // Additional check for proper length
      if (address.length < 32 || address.length > 44) {
        throw new Error('Invalid address length');
      }

      return address;
    } catch (error) {
      throw new Error(`Invalid Solana address format: ${address}`);
    }
  }

  async getWallet(address: string): Promise<Keypair> {
    try {
      // Validate the address format first
      const validatedAddress = Solana.validateAddress(address);

      // Use the safe wallet file path utility to prevent path injection
      const safeWalletPath = getSafeWalletFilePath('solana', validatedAddress);

      // Read the wallet file using the safe path
      const encryptedPrivateKey: string = await fse.readFile(safeWalletPath, 'utf8');

      const passphrase = ConfigManagerCertPassphrase.readPassphrase();
      if (!passphrase) {
        throw new Error('missing passphrase');
      }
      const decrypted = await this.decrypt(encryptedPrivateKey, passphrase);

      return Keypair.fromSecretKey(new Uint8Array(bs58.decode(decrypted)));
    } catch (error) {
      if (error.message.includes('Invalid Solana address')) {
        throw error; // Re-throw validation errors
      }
      if (error.code === 'ENOENT') {
        throw new Error(`Wallet not found for address: ${address}`);
      }
      throw error;
    }
  }

  /**
   * Check if an address is a hardware wallet
   */
  async isHardwareWallet(address: string): Promise<boolean> {
    try {
      return await isHardwareWalletUtil('solana', address);
    } catch (error) {
      logger.error(`Error checking hardware wallet status: ${error.message}`);
      return false;
    }
  }

  /**
   * Get the HeliusService instance if initialized
   */
  public getHeliusService(): HeliusService | null {
    return this.heliusService || null;
  }

  /**
   * Get the PublicKey object for a wallet address
   * This is used for hardware wallets where we only need the public key
   */
  async getPublicKey(address: string): Promise<PublicKey> {
    try {
      return new PublicKey(address);
    } catch (error) {
      throw new Error(`Invalid Solana address: ${address}`);
    }
  }

  async encrypt(secret: string, password: string): Promise<string> {
    const algorithm = 'aes-256-ctr';
    const iv = crypto.randomBytes(16);
    const salt = crypto.randomBytes(32);
    const key = crypto.pbkdf2Sync(password, new Uint8Array(salt), 5000, 32, 'sha512');
    const cipher = crypto.createCipheriv(algorithm, new Uint8Array(key), new Uint8Array(iv));

    const encryptedBuffers = [
      new Uint8Array(cipher.update(new Uint8Array(Buffer.from(secret)))),
      new Uint8Array(cipher.final()),
    ];
    const encrypted = Buffer.concat(encryptedBuffers);

    const ivJSON = iv.toJSON();
    const saltJSON = salt.toJSON();
    const encryptedJSON = encrypted.toJSON();

    return JSON.stringify({
      algorithm,
      iv: ivJSON,
      salt: saltJSON,
      encrypted: encryptedJSON,
    });
  }

  async decrypt(encryptedSecret: string, password: string): Promise<string> {
    const hash = JSON.parse(encryptedSecret);
    const salt = new Uint8Array(Buffer.from(hash.salt, 'utf8'));
    const iv = new Uint8Array(Buffer.from(hash.iv, 'utf8'));

    const key = crypto.pbkdf2Sync(password, salt, 5000, 32, 'sha512');

    const decipher = crypto.createDecipheriv(hash.algorithm, new Uint8Array(key), iv);

    const decryptedBuffers = [
      new Uint8Array(decipher.update(new Uint8Array(Buffer.from(hash.encrypted, 'hex')))),
      new Uint8Array(decipher.final()),
    ];
    const decrypted = Buffer.concat(decryptedBuffers);

    return decrypted.toString();
  }

  /**
   * @deprecated Use the optimized implementation in routes/balances.ts instead
   */
  async getBalance(wallet: Keypair, symbols?: string[]): Promise<Record<string, number>> {
    const publicKey = wallet.publicKey;
    const balances: Record<string, number> = {};

    // Treat empty array as if no tokens were specified
    const effectiveSymbols = symbols && symbols.length === 0 ? undefined : symbols;

    // Fetch SOL balance only if symbols is undefined or includes "SOL" (case-insensitive)
    if (!effectiveSymbols || effectiveSymbols.some((s) => s.toUpperCase() === 'SOL')) {
      const solBalance = await this.connection.getBalance(publicKey);
      const solBalanceInSol = solBalance * LAMPORT_TO_SOL;
      balances['SOL'] = solBalanceInSol;
    }

    // Return early if only SOL balance was requested
    if (effectiveSymbols && effectiveSymbols.length === 1 && effectiveSymbols[0].toUpperCase() === 'SOL') {
      return balances;
    }

    // Get all token accounts for the provided address using jsonParsed encoding
    const [legacyAccounts, token2022Accounts] = await Promise.all([
      this.connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: TOKEN_PROGRAM_ID,
      }),
      this.connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: TOKEN_2022_PROGRAM_ID,
      }),
    ]);

    const allAccounts = [...legacyAccounts.value, ...token2022Accounts.value];

    // Track tokens that were found and those that still need to be fetched
    const foundTokens = new Set<string>();
    const tokensToFetch = new Map<string, string>(); // Maps address -> display symbol

    // Create a mapping of all mint addresses to their token accounts
    const mintToAccount = new Map();
    for (const account of allAccounts) {
      try {
        const parsedInfo = account.account.data.parsed?.info;
        if (!parsedInfo) {
          logger.warn('Account data not parsed or missing info');
          continue;
        }
        const mintAddress = parsedInfo.mint;
        mintToAccount.set(mintAddress, {
          parsedAccount: {
            mint: new PublicKey(mintAddress),
            amount: BigInt(parsedInfo.tokenAmount.amount),
            decimals: parsedInfo.tokenAmount.decimals,
          },
          value: account,
        });
      } catch (error) {
        logger.warn(`Error processing parsed account: ${error.message}`);
        continue;
      }
    }

    // Process requested specific symbols
    if (effectiveSymbols) {
      for (const s of effectiveSymbols) {
        // Skip SOL as it's handled separately
        if (s.toUpperCase() === 'SOL') {
          foundTokens.add('SOL');
          continue;
        }

        // Check if it's a token symbol in our list
        const tokenBySymbol = this.tokenList.find((t) => t.symbol.toUpperCase() === s.toUpperCase());

        if (tokenBySymbol) {
          foundTokens.add(tokenBySymbol.symbol);

          // Check if we have this token in the wallet
          if (mintToAccount.has(tokenBySymbol.address)) {
            const { parsedAccount } = mintToAccount.get(tokenBySymbol.address);
            const amount = parsedAccount.amount;
            const uiAmount = Number(amount) / Math.pow(10, tokenBySymbol.decimals);
            balances[tokenBySymbol.symbol] = uiAmount;
            logger.debug(`Found balance for ${tokenBySymbol.symbol}: ${uiAmount}`);
          } else {
            // Token not found in wallet, set balance to 0
            balances[tokenBySymbol.symbol] = 0;
            logger.debug(`No balance found for ${tokenBySymbol.symbol}, setting to 0`);
          }
        }
        // If it looks like a Solana address, prepare to fetch it directly
        else if (s.length >= 32 && s.length <= 44) {
          try {
            // Validate it's a proper public key
            const pubKey = new PublicKey(s);
            const mintAddress = pubKey.toBase58();

            // Check if we have this mint in the wallet
            if (mintToAccount.has(mintAddress)) {
              const { parsedAccount } = mintToAccount.get(mintAddress);

              // Try to get token from our token list
              const token = this.tokenList.find((t) => t.address === mintAddress);

              if (token) {
                // Token is in our list
                foundTokens.add(token.symbol);
                const amount = parsedAccount.amount;
                const uiAmount = Number(amount) / Math.pow(10, token.decimals);
                balances[token.symbol] = uiAmount;
                logger.debug(`Found balance for ${token.symbol} (${mintAddress}): ${uiAmount}`);
              } else {
                // Token is not in our list, need to fetch its metadata
                tokensToFetch.set(mintAddress, s);
              }
            } else {
              // Mint not found in wallet, add to tokens to fetch for metadata
              tokensToFetch.set(mintAddress, s);
            }
          } catch (e) {
            logger.warn(`Invalid token address format: ${s}`);
          }
        } else {
          logger.warn(`Token not recognized: ${s} (not a known symbol or valid address)`);
        }
      }
    } else {
      // No symbols provided or empty array - check all tokens in the token list
      // Note: When symbols is an empty array, we check all tokens in the token list
      logger.info(`Checking balances for all ${this.tokenList.length} tokens in the token list`);

      // Process all tokens from the token list
      for (const token of this.tokenList) {
        // Skip if already processed
        if (token.symbol === 'SOL' || foundTokens.has(token.symbol)) {
          continue;
        }

        // Check if we have this token in the wallet
        if (mintToAccount.has(token.address)) {
          const { parsedAccount } = mintToAccount.get(token.address);
          const amount = parsedAccount.amount;
          const uiAmount = Number(amount) / Math.pow(10, token.decimals);
          balances[token.symbol] = uiAmount;
          logger.debug(`Found balance for ${token.symbol} (${token.address}): ${uiAmount}`);
        } else {
          // Set balance to 0 for tokens in the list but not in wallet
          balances[token.symbol] = 0;
          logger.debug(`No balance found for ${token.symbol} (${token.address}), setting to 0`);
        }
      }
    }

    // Fetch metadata for unknown tokens
    for (const [mintAddress] of tokensToFetch.entries()) {
      try {
        // Check if we have this mint in the wallet
        let balance = 0;
        let decimals = 0;

        if (mintToAccount.has(mintAddress)) {
          const { parsedAccount } = mintToAccount.get(mintAddress);
          // Fetch mint info to get decimals
          const mintInfo = await getMint(this.connection, parsedAccount.mint);
          decimals = mintInfo.decimals;

          // Calculate balance
          const amount = parsedAccount.amount;
          balance = Number(amount) / Math.pow(10, decimals);
        } else {
          // Try to get decimals anyway for the display
          try {
            const mintInfo = await getMint(this.connection, new PublicKey(mintAddress));
            decimals = mintInfo.decimals;
          } catch (error) {
            logger.warn(`Could not fetch mint info for ${mintAddress}: ${error.message}`);
            decimals = 9; // Default to 9 decimals
          }
        }

        // Use the full mint address as the display key for the balance
        balances[mintAddress] = balance;
        logger.debug(`Using full address as display key for ${mintAddress} with balance ${balance}`);
      } catch (error) {
        logger.error(`Failed to process token ${mintAddress}: ${error.message}`);
      }
    }

    // Filter out zero balances when no specific tokens are requested
    if (!symbols || (symbols && symbols.length === 0)) {
      const filteredBalances: Record<string, number> = {};

      // Keep SOL balance regardless of its value
      if ('SOL' in balances) {
        filteredBalances['SOL'] = balances['SOL'];
      }

      // Filter other tokens with zero balances
      Object.entries(balances).forEach(([key, value]) => {
        if (key !== 'SOL' && value > 0) {
          filteredBalances[key] = value;
        }
      });

      return filteredBalances;
    }

    return balances;
  }

  /**
   * Get balances for a given address
   * @param address Wallet address
   * @param tokens Optional array of token symbols/addresses to fetch. If not provided, fetches tokens from token list
   * @param fetchAll If true, fetches all tokens in wallet including unknown ones
   * @returns Map of token symbol to balance
   */
  public async getBalances(
    address: string,
    tokens?: string[],
    fetchAll: boolean = false,
  ): Promise<Record<string, number>> {
    const publicKey = new PublicKey(address);
    const balances: Record<string, number> = {};

    // Treat empty array as if no tokens were specified
    const effectiveSymbols = tokens && tokens.length === 0 ? undefined : tokens;

    // Always fetch SOL balance if no specific tokens or SOL is requested
    const SOL_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
    if (!effectiveSymbols || effectiveSymbols.some((s) => s.toUpperCase() === 'SOL' || s === SOL_NATIVE_MINT)) {
      balances['SOL'] = await this.getSolBalance(publicKey);
    }

    // Return early if only SOL was requested
    if (
      effectiveSymbols &&
      effectiveSymbols.length === 1 &&
      (effectiveSymbols[0].toUpperCase() === 'SOL' || effectiveSymbols[0] === SOL_NATIVE_MINT)
    ) {
      return balances;
    }

    // Fetch all token accounts
    const tokenAccounts = await this.fetchTokenAccounts(publicKey);
    if (tokenAccounts.size === 0) {
      return this.handleEmptyTokenAccounts(balances, effectiveSymbols);
    }

    // Process tokens based on request type
    if (effectiveSymbols) {
      // Specific tokens requested
      await this.processSpecificTokens(tokenAccounts, effectiveSymbols, balances);
    } else if (fetchAll) {
      // Fetch all tokens in wallet
      await this.processAllTokens(tokenAccounts, balances);
    } else {
      // Default: only tokens in token list
      await this.processTokenListOnly(tokenAccounts, balances);
    }

    // Filter results if no specific tokens were requested
    if (!effectiveSymbols) {
      return this.filterZeroBalances(balances);
    }

    return balances;
  }

  /**
   * Get SOL balance for a public key
   */
  private async getSolBalance(publicKey: PublicKey): Promise<number> {
    try {
      const solBalance = await this.connection.getBalance(publicKey);
      return solBalance * LAMPORT_TO_SOL;
    } catch (error) {
      logger.error(`Error fetching SOL balance: ${error.message}`);
      return 0;
    }
  }

  /**
   * Fetch all token accounts for a public key using jsonParsed encoding for efficiency
   */
  private async fetchTokenAccounts(publicKey: PublicKey): Promise<Map<string, TokenAccount>> {
    const tokenAccountsMap = new Map<string, TokenAccount>();

    try {
      // Use getParsedTokenAccountsByOwner - Helius optimization technique
      // This returns pre-parsed data, avoiding manual unpacking
      const tokenAccountsPromise = Promise.all([
        this.connection.getParsedTokenAccountsByOwner(publicKey, {
          programId: TOKEN_PROGRAM_ID,
        }),
        this.connection.getParsedTokenAccountsByOwner(publicKey, {
          programId: TOKEN_2022_PROGRAM_ID,
        }),
      ]);

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Token accounts request timed out')), 10000);
      });

      const [legacyAccounts, token2022Accounts] = (await Promise.race([tokenAccountsPromise, timeoutPromise])) as any;

      const allAccounts = [...legacyAccounts.value, ...token2022Accounts.value];
      logger.info(`Found ${allAccounts.length} token accounts for ${publicKey.toString()}`);

      // With getParsedTokenAccountsByOwner, data is already structured - no unpacking needed
      for (const account of allAccounts) {
        try {
          const parsedInfo = account.account.data.parsed?.info;
          if (!parsedInfo) {
            logger.warn('Account data not parsed or missing info');
            continue;
          }
          const mintAddress = parsedInfo.mint;

          // Store in format compatible with existing code
          tokenAccountsMap.set(mintAddress, {
            parsedAccount: {
              mint: new PublicKey(mintAddress),
              owner: new PublicKey(parsedInfo.owner),
              amount: BigInt(parsedInfo.tokenAmount.amount),
              decimals: parsedInfo.tokenAmount.decimals,
              isNative: parsedInfo.isNative || false,
              delegatedAmount: parsedInfo.delegatedAmount ? BigInt(parsedInfo.delegatedAmount.amount) : BigInt(0),
              delegate: parsedInfo.delegate ? new PublicKey(parsedInfo.delegate) : null,
              state: parsedInfo.state,
              isInitialized: parsedInfo.state !== 'uninitialized',
              isFrozen: parsedInfo.state === 'frozen',
              rentExemptReserve: parsedInfo.isNative ? BigInt(parsedInfo.isNative) : null,
              closeAuthority: parsedInfo.closeAuthority ? new PublicKey(parsedInfo.closeAuthority) : null,
            },
            value: account,
          });
        } catch (error) {
          logger.warn(`Error processing parsed account: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error(`Error fetching token accounts: ${error.message}`);
    }

    return tokenAccountsMap;
  }

  /**
   * Handle case when no token accounts are found
   */
  private handleEmptyTokenAccounts(
    balances: Record<string, number>,
    effectiveSymbols?: string[],
  ): Record<string, number> {
    const SOL_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
    if (effectiveSymbols) {
      // Set all requested tokens to 0
      for (const symbol of effectiveSymbols) {
        if (symbol.toUpperCase() !== 'SOL' && symbol !== SOL_NATIVE_MINT) {
          balances[symbol] = 0;
        }
      }
    }
    return balances;
  }

  /**
   * Process specific tokens requested by the user
   */
  private async processSpecificTokens(
    tokenAccounts: Map<string, TokenAccount>,
    symbols: string[],
    balances: Record<string, number>,
  ): Promise<void> {
    const SOL_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
    for (const symbol of symbols) {
      if (symbol.toUpperCase() === 'SOL' || symbol === SOL_NATIVE_MINT) continue;

      // Try to find token by symbol
      const tokenInfo = this.tokenList.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase());

      if (tokenInfo) {
        // Token found in list
        const balance = this.getTokenBalance(tokenAccounts.get(tokenInfo.address), tokenInfo.decimals);
        balances[tokenInfo.symbol] = balance;
      } else if (this.isValidSolanaAddress(symbol)) {
        // Try as mint address
        const tokenAccount = tokenAccounts.get(symbol);
        if (tokenAccount) {
          const balance = await this.getTokenBalanceWithMintInfo(tokenAccount, symbol);
          balances[symbol] = balance;
        } else {
          balances[symbol] = 0;
        }
      } else {
        logger.warn(`Token not recognized: ${symbol}`);
        balances[symbol] = 0;
      }
    }
  }

  /**
   * Process all tokens in wallet (fetchAll=true)
   */
  private async processAllTokens(
    tokenAccounts: Map<string, TokenAccount>,
    balances: Record<string, number>,
  ): Promise<void> {
    logger.info('Processing all token accounts (fetchAll=true)');

    for (const [mintAddress, tokenAccount] of tokenAccounts) {
      try {
        // Check if token is in our list
        const tokenInfo = this.tokenList.find((t) => t.address === mintAddress);

        if (tokenInfo) {
          const balance = this.getTokenBalance(tokenAccount, tokenInfo.decimals);
          balances[tokenInfo.symbol] = balance;
        } else {
          // Fetch mint info for unknown token
          const balance = await this.getTokenBalanceWithMintInfo(tokenAccount, mintAddress);
          if (balance > 0) {
            balances[mintAddress] = balance;
          }
        }
      } catch (error) {
        logger.warn(`Error processing token ${mintAddress}: ${error.message}`);
      }
    }
  }

  /**
   * Process only tokens that are in the token list (default behavior)
   */
  private async processTokenListOnly(
    tokenAccounts: Map<string, TokenAccount>,
    balances: Record<string, number>,
  ): Promise<void> {
    logger.info(`Checking balances for ${this.tokenList.length} tokens in token list`);

    for (const tokenInfo of this.tokenList) {
      if (tokenInfo.symbol === 'SOL') continue;

      const tokenAccount = tokenAccounts.get(tokenInfo.address);
      if (tokenAccount) {
        const balance = this.getTokenBalance(tokenAccount, tokenInfo.decimals);
        if (balance > 0) {
          balances[tokenInfo.symbol] = balance;
        }
      }
    }
  }

  /**
   * Get token balance from a token account
   */
  private getTokenBalance(tokenAccount: TokenAccount | undefined, decimals: number): number {
    if (!tokenAccount) return 0;

    const amount = tokenAccount.parsedAccount.amount;
    return Number(amount) / Math.pow(10, decimals);
  }

  /**
   * Get token balance with mint info lookup
   */
  private async getTokenBalanceWithMintInfo(tokenAccount: TokenAccount, mintAddress: string): Promise<number> {
    try {
      const programId = tokenAccount.value.account.owner;
      const mintInfo = await Promise.race([
        getMint(this.connection, new PublicKey(mintAddress), undefined, programId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Mint info timeout')), 1000)),
      ]);

      const amount = tokenAccount.parsedAccount.amount;
      return Number(amount) / Math.pow(10, mintInfo.decimals);
    } catch (error) {
      // Use default 9 decimals if mint info fails
      logger.debug(`Failed to get mint info for ${mintAddress}, using default decimals`);
      const amount = tokenAccount.parsedAccount.amount;
      return Number(amount) / Math.pow(10, 9);
    }
  }

  /**
   * Check if a string is a valid Solana address
   */
  private isValidSolanaAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Filter out zero balances (except SOL)
   */
  private filterZeroBalances(balances: Record<string, number>): Record<string, number> {
    const filtered: Record<string, number> = {};

    // Always include SOL
    if ('SOL' in balances) {
      filtered['SOL'] = balances['SOL'];
    }

    // Add non-zero balances
    for (const [key, value] of Object.entries(balances)) {
      if (key !== 'SOL' && value > 0) {
        filtered[key] = value;
      }
    }

    return filtered;
  }

  // returns a Solana TransactionResponse for a txHash.
  async getTransaction(payerSignature: string): Promise<VersionedTransactionResponse | null> {
    return this.connection.getTransaction(payerSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
  }

  // returns a Solana TransactionResponseStatusCode for a txData.
  public async getTransactionStatusCode(txData: TransactionResponse | null): Promise<TransactionResponseStatusCode> {
    let txStatus;
    if (!txData) {
      // tx not yet confirmed by validator
      txStatus = TransactionResponseStatusCode.UNCONFIRMED;
    } else {
      // If txData exists, check if there's an error in the metadata
      txStatus =
        txData.meta?.err == null ? TransactionResponseStatusCode.CONFIRMED : TransactionResponseStatusCode.FAILED;
    }
    return txStatus;
  }

  // returns the current block number
  async getCurrentBlockNumber(): Promise<number> {
    return await this.connection.getSlot('processed');
  }

  async close() {
    if (this.network in Solana._instances) {
      delete Solana._instances[this.network];
    }
  }

  public async estimateGas(computeUnits?: number): Promise<number> {
    const computeUnitsToUse = computeUnits || this.config.defaultComputeUnits;
    const priorityFeePerCU = await this.estimateGasPrice();
    const priorityFee = computeUnitsToUse * priorityFeePerCU;

    // Add base fee (in lamports) and convert total to SOL
    const totalLamports = BASE_FEE + priorityFee;
    const gasCost = totalLamports * LAMPORT_TO_SOL;

    return gasCost;
  }

  /**
   * Prepare gas options for a transaction
   * @param priorityFeePerCU Priority fee in lamports per compute unit (optional)
   * @param computeUnits Compute units limit (optional)
   * @returns Gas options object containing priorityFeePerCU and computeUnits
   */
  public async prepareGasOptions(
    priorityFeePerCU?: number,
    computeUnits?: number,
  ): Promise<{
    priorityFeePerCU: number;
    computeUnits: number;
  }> {
    // If priorityFeePerCU not provided, estimate it
    const feePerCU = priorityFeePerCU ?? (await this.estimateGasPrice());

    // Use default compute units if not provided
    const units = computeUnits || this.config.defaultComputeUnits;

    return {
      priorityFeePerCU: feePerCU,
      computeUnits: units,
    };
  }

  async estimateGasPrice(): Promise<number> {
    return await SolanaPriorityFees.estimatePriorityFee(this.config);
  }

  public async confirmTransaction(
    signature: string,
    timeout: number = 3000,
  ): Promise<{ confirmed: boolean; txData?: any }> {
    try {
      // Use Helius WebSocket monitoring if available for real-time confirmation
      if (this.heliusService.isWebSocketConnected()) {
        logger.info(`Using WebSocket monitoring for transaction ${signature}`);
        return await this.heliusService.monitorTransaction(signature, timeout);
      }

      // Fallback to polling-based confirmation
      logger.info(`Using polling-based confirmation for transaction ${signature}`);
      const confirmationPromise = new Promise<{
        confirmed: boolean;
        txData?: any;
      }>(async (resolve, reject) => {
        // Use getTransaction instead of getSignatureStatuses for more reliability
        const txData = await this.connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });

        if (!txData) {
          return resolve({ confirmed: false });
        }

        // Check if transaction is already confirmed but had an error
        if (txData.meta?.err) {
          return reject(new Error(`Transaction failed with error: ${JSON.stringify(txData.meta.err)}`));
        }

        // More definitive check using slot confirmation
        const status = await this.connection.getSignatureStatus(signature);
        const isConfirmed =
          status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized';

        resolve({ confirmed: !!isConfirmed, txData });
      });

      const timeoutPromise = new Promise<{ confirmed: boolean }>((_, reject) =>
        setTimeout(() => reject(new Error('Confirmation timed out')), timeout),
      );

      return await Promise.race([confirmationPromise, timeoutPromise]);
    } catch (error: any) {
      throw new Error(`Failed to confirm transaction: ${error.message}`);
    }
  }

  private getFee(txData: any): number {
    if (!txData?.meta) {
      return 0;
    }
    // Convert fee from lamports to SOL
    return (txData.meta.fee || 0) * LAMPORT_TO_SOL;
  }

  public async sendAndConfirmTransaction(
    tx: Transaction | VersionedTransaction,
    signers: Signer[] = [],
    priorityFeePerCU?: number,
  ): Promise<{ signature: string; fee: number }> {
    // Use provided priority fee or estimate it
    const currentPriorityFee = priorityFeePerCU ?? (await this.estimateGasPrice());

    // Always simulate transaction to get actual compute units
    let computeUnitsToUse: number;
    try {
      let simulationResult;

      if (tx instanceof Transaction) {
        // For regular transactions, simulate with the Transaction object
        const result = await this.connection.simulateTransaction(tx);
        simulationResult = result.value;
      } else {
        // For versioned transactions, use the config object
        const result = await this.connection.simulateTransaction(tx, {
          replaceRecentBlockhash: true,
          sigVerify: false,
        });
        simulationResult = result.value;
      }

      if (simulationResult.unitsConsumed) {
        // Add 10% margin for safety
        computeUnitsToUse = Math.ceil(simulationResult.unitsConsumed * 1.1);
        logger.info(
          `Simulation consumed ${simulationResult.unitsConsumed} units, using ${computeUnitsToUse} with 10% margin`,
        );
      } else {
        // Fallback to default if simulation doesn't return units
        computeUnitsToUse = this.config.defaultComputeUnits;
        logger.warn('Simulation did not return units consumed, using default');
      }
    } catch (error) {
      logger.warn(`Failed to simulate for compute units: ${error.message}, using default`);
      computeUnitsToUse = this.config.defaultComputeUnits;
    }

    const basePriorityFeeLamports = currentPriorityFee * computeUnitsToUse;
    logger.info(
      `Sending transaction with ${currentPriorityFee} lamports/CU priority fee and total priority fee of ${(basePriorityFeeLamports * LAMPORT_TO_SOL).toFixed(6)} SOL`,
    );

    // Prepare transaction with compute budget
    if (tx instanceof Transaction) {
      tx = await this.prepareTx(tx, currentPriorityFee, computeUnitsToUse, signers);
    } else {
      tx = await this.prepareVersionedTx(tx, currentPriorityFee, computeUnitsToUse, signers);
    }

    // Use the confirmation retry logic from sendAndConfirmRawTransaction
    const serializedTx = tx.serialize();
    const { confirmed, signature, txData } = await this._sendAndConfirmRawTransaction(serializedTx);

    if (confirmed && txData) {
      const actualFee = this.getFee(txData);
      logger.info(`Transaction ${signature} confirmed with total fee: ${actualFee.toFixed(6)} SOL`);
      return { signature, fee: actualFee };
    }

    throw new Error(`Transaction failed to confirm after ${this.config.confirmRetryCount} attempts`);
  }

  private async prepareTx(
    tx: Transaction,
    currentPriorityFee: number,
    computeUnitsToUse: number,
    signers: Signer[],
  ): Promise<Transaction> {
    const priorityFeeMicroLamports = Math.floor(currentPriorityFee * 1_000_000);
    const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFeeMicroLamports,
    });

    // Remove any existing priority fee instructions and add the new one
    tx.instructions = [
      ...tx.instructions.filter((inst) => !inst.programId.equals(ComputeBudgetProgram.programId)),
      priorityFeeInstruction,
    ];

    // Set compute unit limit
    const computeUnitInstruction = ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnitsToUse,
    });
    tx.add(computeUnitInstruction);

    // Get latest blockhash
    const {
      value: { lastValidBlockHeight, blockhash },
    } = await this.connection.getLatestBlockhashAndContext('confirmed');

    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.recentBlockhash = blockhash;
    tx.sign(...signers);

    return tx;
  }

  private async prepareVersionedTx(
    tx: VersionedTransaction,
    currentPriorityFee: number,
    computeUnits: number,
    _signers: Signer[],
  ): Promise<VersionedTransaction> {
    const originalMessage = tx.message;
    const originalStaticCount = originalMessage.staticAccountKeys.length;
    const originalSignatures = tx.signatures; // Clone original signatures array

    let modifiedTx: VersionedTransaction;

    // Create new compute budget instructions
    const priorityFeeMicroLamports = Math.floor(currentPriorityFee * 1_000_000);
    const computeBudgetInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeMicroLamports,
      }),
    ];

    // Check if ComputeBudgetProgram is in static keys
    const computeBudgetProgramIndex = originalMessage.staticAccountKeys.findIndex((key) =>
      key.equals(ComputeBudgetProgram.programId),
    );

    // Add ComputeBudget program to static keys, adjust indexes, and create modified instructions
    if (computeBudgetProgramIndex === -1) {
      // Add ComputeBudget program to static keys
      const newStaticKeys = [...originalMessage.staticAccountKeys, ComputeBudgetProgram.programId];

      // Process original instructions with index adjustment
      const originalInstructions = originalMessage.compiledInstructions.map((ix) => ({
        ...ix,
        accountKeyIndexes: ix.accountKeyIndexes.map((index) => (index >= originalStaticCount ? index + 1 : index)),
      }));

      // Create modified instructions
      const modifiedInstructions = [
        ...computeBudgetInstructions.map((ix) => ({
          programIdIndex: newStaticKeys.indexOf(ComputeBudgetProgram.programId), // Use new index
          accountKeyIndexes: [],
          data: ix.data instanceof Buffer ? new Uint8Array(ix.data) : ix.data,
        })),
        ...originalInstructions,
      ];

      // Build new transaction
      modifiedTx = new VersionedTransaction(
        new MessageV0({
          header: originalMessage.header,
          staticAccountKeys: newStaticKeys,
          recentBlockhash: originalMessage.recentBlockhash!,
          compiledInstructions: modifiedInstructions.map((ix) => ({
            programIdIndex: ix.programIdIndex,
            accountKeyIndexes: ix.accountKeyIndexes,
            data: ix.data instanceof Buffer ? new Uint8Array(ix.data) : ix.data,
          })),
          addressTableLookups: originalMessage.addressTableLookups,
        }),
      );
    } else {
      // Remove compute budget instructions from original instructions
      const nonComputeBudgetInstructions = originalMessage.compiledInstructions.filter(
        (ix) => !originalMessage.staticAccountKeys[ix.programIdIndex].equals(ComputeBudgetProgram.programId),
      );

      // Create modified instructions
      const modifiedInstructions = [
        ...computeBudgetInstructions.map((ix) => ({
          programIdIndex: computeBudgetProgramIndex, // Use existing index if already present
          accountKeyIndexes: [],
          data: ix.data instanceof Buffer ? new Uint8Array(ix.data) : ix.data,
        })),
        ...nonComputeBudgetInstructions,
      ];
      // Build new transaction with same keys but modified instructions
      modifiedTx = new VersionedTransaction(
        new MessageV0({
          header: originalMessage.header,
          staticAccountKeys: originalMessage.staticAccountKeys,
          recentBlockhash: originalMessage.recentBlockhash,
          compiledInstructions: modifiedInstructions.map((ix) => ({
            programIdIndex: ix.programIdIndex,
            accountKeyIndexes: ix.accountKeyIndexes,
            data: ix.data instanceof Buffer ? new Uint8Array(ix.data) : ix.data,
          })),
          addressTableLookups: originalMessage.addressTableLookups,
        }),
      );
    }
    // DON'T DELETE COMMENTS BELOW
    // console.log('Original message:', JSON.stringify({
    //   message: {
    //     header: originalMessage.header,
    //     staticAccountKeys: originalMessage.staticAccountKeys.map(k => k.toBase58()),
    //     recentBlockhash: originalMessage.recentBlockhash,
    //     compiledInstructions: originalMessage.compiledInstructions.map(ix => ({
    //       programIdIndex: ix.programIdIndex,
    //       accountKeyIndexes: ix.accountKeyIndexes,
    //       data: bs58.encode(ix.data)
    //     })),
    //     addressTableLookups: originalMessage.addressTableLookups
    //   }
    // }, null, 2));
    // console.log('Modified transaction:', JSON.stringify({
    //   message: {
    //     header: modifiedTx.message.header,
    //     staticAccountKeys: modifiedTx.message.staticAccountKeys.map(k => k.toBase58()),
    //     recentBlockhash: modifiedTx.message.recentBlockhash,
    //     compiledInstructions: modifiedTx.message.compiledInstructions.map(ix => ({
    //       programIdIndex: ix.programIdIndex,
    //       accountKeyIndexes: ix.accountKeyIndexes,
    //       data: bs58.encode(ix.data)
    //     })),
    //     addressTableLookups: modifiedTx.message.addressTableLookups
    //   }
    // }, null, 2));

    modifiedTx.signatures = originalSignatures;
    modifiedTx.sign([..._signers]);
    console.log('modifiedTx:', modifiedTx);

    return modifiedTx;
  }

  /**
   * Add Jito tip instruction to a VersionedTransaction for Helius Sender
   */
  private async addJitoTipToTransaction(
    transaction: VersionedTransaction,
    payerPublicKey: PublicKey,
  ): Promise<VersionedTransaction> {
    if (!this.heliusConfig.useHeliusSender || !this.heliusConfig.jitoTipSOL) {
      return transaction;
    }

    const tipAmount = Math.floor(this.heliusConfig.jitoTipSOL * LAMPORTS_PER_SOL);
    const randomTipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

    // Validate tip account
    if (!randomTipAccount || typeof randomTipAccount !== 'string') {
      throw new Error(`Invalid tip account selected: ${randomTipAccount}`);
    }

    // Create tip instruction
    let tipAccountKey: PublicKey;
    try {
      tipAccountKey = new PublicKey(randomTipAccount);
    } catch (error: any) {
      throw new Error(`Failed to create PublicKey for tip account ${randomTipAccount}: ${error.message}`);
    }

    const tipInstruction = SystemProgram.transfer({
      fromPubkey: payerPublicKey,
      toPubkey: tipAccountKey,
      lamports: tipAmount,
    });

    const originalMessage = transaction.message;
    const originalStaticCount = originalMessage.staticAccountKeys.length;

    // Add SystemProgram to static keys if not already present
    const newStaticKeys = [...originalMessage.staticAccountKeys];
    const systemProgramIndex = newStaticKeys.findIndex((key) => key.equals(SystemProgram.programId));

    if (systemProgramIndex === -1) {
      newStaticKeys.push(SystemProgram.programId);
    }

    // Add payer to static keys if not already present
    const payerIndex = newStaticKeys.findIndex((key) => key.equals(payerPublicKey));
    if (payerIndex === -1) {
      newStaticKeys.push(payerPublicKey);
    }

    // Add tip account to static keys if not already present
    const tipAccountIndex = newStaticKeys.findIndex((key) => key.equals(tipAccountKey));

    if (tipAccountIndex === -1) {
      newStaticKeys.push(tipAccountKey);
    }

    // Process original instructions with index adjustment
    const indexOffset = newStaticKeys.length - originalStaticCount;
    const originalInstructions = originalMessage.compiledInstructions.map((ix) => ({
      ...ix,
      accountKeyIndexes: ix.accountKeyIndexes.map((index) =>
        index >= originalStaticCount ? index + indexOffset : index,
      ),
    }));

    // Create tip instruction - find final indexes after all accounts are added
    const finalPayerIndex = newStaticKeys.findIndex((key) => key.equals(payerPublicKey));
    const finalTipAccountIdx = newStaticKeys.findIndex((key) => key.equals(tipAccountKey));
    const finalSystemProgramIdx = newStaticKeys.findIndex((key) => key.equals(SystemProgram.programId));

    const tipInstructionCompiled = {
      programIdIndex: finalSystemProgramIdx,
      accountKeyIndexes: [
        finalPayerIndex, // from
        finalTipAccountIdx, // to
      ],
      data: tipInstruction.data instanceof Buffer ? new Uint8Array(tipInstruction.data) : tipInstruction.data,
    };

    // Combine all instructions (tip instruction first)
    const allInstructions = [tipInstructionCompiled, ...originalInstructions];

    // Create new transaction with tip instruction
    const modifiedTx = new VersionedTransaction(
      new MessageV0({
        header: originalMessage.header,
        staticAccountKeys: newStaticKeys,
        recentBlockhash: originalMessage.recentBlockhash,
        compiledInstructions: allInstructions.map((ix) => ({
          programIdIndex: ix.programIdIndex,
          accountKeyIndexes: ix.accountKeyIndexes,
          data: ix.data instanceof Buffer ? new Uint8Array(ix.data) : ix.data,
        })),
        addressTableLookups: originalMessage.addressTableLookups,
      }),
    );

    // Copy original signatures - transaction will need to be re-signed by caller
    modifiedTx.signatures = [...transaction.signatures];

    logger.info(
      `Jito tip transaction created successfully with ${modifiedTx.message.staticAccountKeys.length} accounts`,
    );
    return modifiedTx;
  }

  async sendAndConfirmRawTransaction(
    transaction: VersionedTransaction | Transaction,
  ): Promise<{ confirmed: boolean; signature: string; txData: any }> {
    // Convert Transaction to VersionedTransaction if necessary
    if (!(transaction instanceof VersionedTransaction)) {
      // Ensure transaction is properly prepared
      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = transaction.recentBlockhash || blockhash;
      transaction.feePayer = transaction.feePayer || transaction.signatures[0]?.publicKey || null;

      // Get serialized transaction bytes
      const serializedTx = transaction.serialize();
      return this._sendAndConfirmRawTransaction(serializedTx);
    }

    // For VersionedTransaction, add Jito tip if using Helius Sender
    let finalTransaction = transaction;
    if (this.heliusConfig.useHeliusSender && this.heliusConfig.jitoTipSOL && this.heliusConfig.jitoTipSOL > 0) {
      // Extract payer from the transaction
      const payer = transaction.message.staticAccountKeys[0]; // First account is always the payer
      finalTransaction = await this.addJitoTipToTransaction(transaction, payer);
    }

    // Serialize the final transaction
    const serializedTx = finalTransaction.serialize();
    return this._sendAndConfirmRawTransaction(serializedTx);
  }

  // Create a private method to handle the actual sending with Helius best practices
  private async _sendAndConfirmRawTransaction(
    serializedTx: Buffer | Uint8Array,
  ): Promise<{ confirmed: boolean; signature: string; txData: any }> {
    // Get latest blockhash for expiration checking
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');

    let signature: string | null = null;

    try {
      // Use Helius Sender if available, otherwise use standard RPC
      if (this.heliusService) {
        try {
          signature = await this.heliusService.sendWithSender(serializedTx);
        } catch (error) {
          // Fallback to standard RPC if Sender fails or is not configured
          logger.info('Falling back to standard RPC transaction sending');
          signature = await this.connection.sendRawTransaction(serializedTx, {
            skipPreflight: true,
            maxRetries: 0, // Don't rely on RPC provider's retry logic
          });
        }
      } else {
        // No Helius service, use standard RPC
        signature = await this.connection.sendRawTransaction(serializedTx, {
          skipPreflight: true,
          maxRetries: 0,
        });
      }

      // Use WebSocket monitoring if available, otherwise fall back to robust polling
      if (this.heliusService && this.heliusService.isWebSocketConnected()) {
        logger.info(`🚀 Sent transaction ${signature}, monitoring via WebSocket...`);
        const confirmationResult = await this.heliusService.monitorTransaction(signature, 60000);

        if (confirmationResult.confirmed) {
          logger.info(`✅ Transaction ${signature} confirmed via WebSocket`);
          return { confirmed: true, signature, txData: confirmationResult.txData };
        } else {
          logger.warn(`❌ Transaction ${signature} not confirmed via WebSocket within timeout`);
          return { confirmed: false, signature, txData: confirmationResult.txData };
        }
      }

      logger.info(`🚀 Sent transaction ${signature}, implementing robust polling confirmation...`);

      // Implement robust polling mechanism as per Helius best practices
      const confirmed = false;
      let attempts = 0;
      const maxPollingAttempts = 30; // 30 attempts * 2s = 60s total timeout

      while (!confirmed && attempts < maxPollingAttempts) {
        attempts++;

        try {
          // Check signature status
          const statuses = await this.connection.getSignatureStatuses([signature]);
          const status = statuses && statuses.value && statuses.value[0];

          if (status) {
            if (status.err) {
              logger.error(`❌ Transaction ${signature} failed with error:`, status.err);
              return { confirmed: false, signature, txData: null };
            }

            if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
              logger.info(`✅ Transaction ${signature} confirmed after ${attempts} attempts`);

              // Get full transaction data
              const txData = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0,
              });

              return { confirmed: true, signature, txData };
            }
          }

          // Check if blockhash has expired
          const currentBlockHeight = await this.connection.getBlockHeight();
          if (currentBlockHeight > lastValidBlockHeight) {
            logger.warn(`Blockhash expired for transaction ${signature}, re-broadcasting...`);

            // Re-broadcast the same transaction (don't re-sign with same blockhash)
            try {
              await this.connection.sendRawTransaction(serializedTx, {
                skipPreflight: true,
                maxRetries: 0,
              });
              logger.info(`Re-broadcasted transaction ${signature}`);
            } catch (rebroadcastError: any) {
              logger.warn(`Failed to re-broadcast: ${rebroadcastError.message}`);
            }

            // Continue polling with original signature
          }

          // Wait before next poll
          await new Promise((resolve) => setTimeout(resolve, this.config.confirmRetryInterval * 1000));
        } catch (pollingError: any) {
          logger.warn(`Polling attempt ${attempts} failed: ${pollingError.message}`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // If we exit the loop without confirmation
      logger.warn(`❌ Transaction ${signature} not confirmed after ${attempts} attempts`);
      return { confirmed: false, signature, txData: null };
    } catch (sendError: any) {
      logger.error(`Failed to send transaction: ${sendError.message}`);
      return { confirmed: false, signature: signature || '', txData: null };
    }
  }

  async sendRawTransaction(rawTx: Buffer | Uint8Array | Array<number>, lastValidBlockHeight: number): Promise<string> {
    const blockheight = await this.connection.getBlockHeight({
      commitment: 'confirmed',
    });

    if (blockheight > lastValidBlockHeight + 50) {
      throw new Error('Maximum blockheight exceeded');
    }

    try {
      const signature = await this.connection.sendRawTransaction(rawTx, {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
        maxRetries: 0,
      });
      return signature;
    } catch (error) {
      logger.error('Failed to send raw transaction:', error);
      throw error;
    }
  }

  /**
   * Extract balance changes and fee from a transaction for multiple tokens
   * @param signature Transaction signature
   * @param owner Owner address (required for SPL tokens and SOL balance extraction)
   * @param tokens Array of token mint addresses or 'SOL' for native SOL
   * @returns Array of balance changes in the same order as tokens, and transaction fee
   */
  async extractBalanceChangesAndFee(
    signature: string,
    owner: string,
    tokens: string[],
  ): Promise<{
    balanceChanges: number[];
    fee: number;
  }> {
    // Fetch transaction details
    const txDetails = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!txDetails) {
      throw new Error(`Transaction ${signature} not found`);
    }

    // Calculate fee (always in SOL)
    const fee = (txDetails.meta?.fee || 0) * LAMPORT_TO_SOL;

    const preBalances = txDetails.meta?.preBalances || [];
    const postBalances = txDetails.meta?.postBalances || [];
    const preTokenBalances = txDetails.meta?.preTokenBalances || [];
    const postTokenBalances = txDetails.meta?.postTokenBalances || [];
    const ownerPubkey = new PublicKey(owner);

    // Process each token and return array of balance changes
    const balanceChanges = tokens.map((token) => {
      // Check if this is native SOL
      if (token === 'So11111111111111111111111111111111111111112') {
        // For native SOL, we need to calculate from lamport balance changes
        const accountIndex = txDetails.transaction.message.accountKeys.findIndex((key) =>
          key.pubkey.equals(ownerPubkey),
        );

        if (accountIndex === -1) {
          logger.warn(`Owner ${owner} not found in transaction accounts`);
          return 0;
        }

        // Calculate SOL change including fees
        const lamportChange = postBalances[accountIndex] - preBalances[accountIndex];
        return lamportChange * LAMPORT_TO_SOL;
      } else {
        // Token mint address provided - get SPL token balance change
        const preBalance =
          preTokenBalances.find((balance) => balance.mint === token && balance.owner === owner)?.uiTokenAmount
            .uiAmount || 0;

        const postBalance =
          postTokenBalances.find((balance) => balance.mint === token && balance.owner === owner)?.uiTokenAmount
            .uiAmount || 0;

        return postBalance - preBalance;
      }
    });

    return { balanceChanges, fee };
  }

  /**
   * Extract balance changes for CLMM operations with proper SOL handling
   * @param signature Transaction signature
   * @param owner Owner address
   * @param baseTokenInfo Base token info object with address and symbol
   * @param quoteTokenInfo Quote token info object with address and symbol
   * @param txFee Transaction fee in lamports (from txData.meta.fee)
   * @returns Object with base and quote token balance changes and calculated rent
   */
  async extractClmmBalanceChanges(
    signature: string,
    owner: string,
    baseTokenInfo: { address: string; symbol: string },
    quoteTokenInfo: { address: string; symbol: string },
    txFee: number,
  ): Promise<{
    baseTokenChange: number;
    quoteTokenChange: number;
    rent: number;
  }> {
    const SOL_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
    const isBaseSol = baseTokenInfo.symbol === 'SOL' || baseTokenInfo.address === SOL_NATIVE_MINT;
    const isQuoteSol = quoteTokenInfo.symbol === 'SOL' || quoteTokenInfo.address === SOL_NATIVE_MINT;

    // Build unique token list for extraction
    const tokensToExtract: string[] = [];
    const tokenIndices: { sol?: number; base?: number; quote?: number } = {};

    // Always include SOL first to track rent
    tokensToExtract.push(SOL_NATIVE_MINT);
    tokenIndices.sol = 0;

    // Add non-SOL tokens
    if (!isBaseSol) {
      tokensToExtract.push(baseTokenInfo.address);
      tokenIndices.base = tokensToExtract.length - 1;
    } else {
      tokenIndices.base = 0; // Base is SOL
    }

    if (!isQuoteSol) {
      tokensToExtract.push(quoteTokenInfo.address);
      tokenIndices.quote = tokensToExtract.length - 1;
    } else {
      tokenIndices.quote = 0; // Quote is SOL
    }

    // Extract balance changes
    const { balanceChanges } = await this.extractBalanceChangesAndFee(signature, owner, tokensToExtract);

    // Get individual balance changes
    const solChange = balanceChanges[tokenIndices.sol!];
    const baseTokenChange = balanceChanges[tokenIndices.base!];
    const quoteTokenChange = balanceChanges[tokenIndices.quote!];

    // Calculate rent from SOL balance
    // When neither token is SOL: rent = |SOL change| - fee
    // When one token is SOL: rent is included in the token's balance change
    let rent = 0;
    if (!isBaseSol && !isQuoteSol) {
      // SOL change = -(fee + rent)
      rent = Math.abs(solChange) - txFee / 1e9;
    } else {
      // For positions, rent is approximately 0.00204928 SOL
      rent = 0.00204928;
    }

    return {
      baseTokenChange,
      quoteTokenChange,
      rent,
    };
  }

  // Validate if a string is a valid Solana private key
  public static validateSolPrivateKey(secretKey: string): boolean {
    try {
      const secretKeyBytes = bs58.decode(secretKey);
      Keypair.fromSecretKey(new Uint8Array(secretKeyBytes));
      return true;
    } catch (error) {
      return false;
    }
  }

  // Update getTokenBySymbol to use new getToken method
  public async getTokenBySymbol(tokenSymbol: string): Promise<TokenInfo | undefined> {
    return (await this.getToken(tokenSymbol)) || undefined;
  }

  public static async getWalletAddressExample(): Promise<string> {
    const chainConfig = getSolanaChainConfig();
    return chainConfig.defaultWallet;
  }

  public async simulateTransaction(transaction: VersionedTransaction | Transaction) {
    try {
      if (!(transaction instanceof VersionedTransaction)) {
        // Convert regular Transaction to VersionedTransaction for simulation
        const { blockhash } = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = transaction.recentBlockhash || blockhash;
        transaction.feePayer = transaction.feePayer || transaction.signatures[0]?.publicKey || null;

        // Convert to VersionedTransaction
        const messageV0 = new MessageV0({
          header: transaction.compileMessage().header,
          staticAccountKeys: transaction.compileMessage().staticAccountKeys,
          recentBlockhash: transaction.recentBlockhash,
          compiledInstructions: transaction.compileMessage().compiledInstructions,
          addressTableLookups: [],
        });

        transaction = new VersionedTransaction(messageV0);
      }

      // Now handle all as VersionedTransaction
      const { value: simulatedTransactionResponse } = await this.connection.simulateTransaction(transaction, {
        replaceRecentBlockhash: false,
        commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: [] },
        sigVerify: false,
      });

      logger.info('Simulation Result:', {
        unitsConsumed: simulatedTransactionResponse.unitsConsumed,
        status: simulatedTransactionResponse.err ? 'FAILED' : 'SUCCESS',
      });

      if (simulatedTransactionResponse.err) {
        const logs = simulatedTransactionResponse.logs || [];
        const errorMessage = `${SIMULATION_ERROR_MESSAGE}\nError: ${JSON.stringify(simulatedTransactionResponse.err)}\nProgram Logs: ${logs.join('\n')}`;

        logger.error(errorMessage);

        throw new Error(errorMessage);
      }
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Transaction simulation failed: ${error.message}`);
        throw error;
      }
      throw new Error(`Error simulating transaction: ${error.message}`);
    }
  }

  /**
   * Helper function to simulate transaction with proper error handling
   * @param transaction Transaction to simulate
   * @param fastify Fastify instance for error responses
   * @returns Promise that resolves if simulation succeeds, throws descriptive error otherwise
   */
  public async simulateWithErrorHandling(
    transaction: VersionedTransaction | Transaction,
    fastify?: any,
  ): Promise<void> {
    try {
      await this.simulateTransaction(transaction);
    } catch (simulationError: any) {
      const errorMessage = simulationError?.message || '';

      // Helpers to safely create HTTP-style errors even if fastify is undefined
      const httpErrors = fastify?.httpErrors;
      const asBadRequest = (msg: string) => {
        if (httpErrors?.badRequest) return httpErrors.badRequest(msg);
        const e = new Error(msg) as Error & { statusCode?: number };
        e.statusCode = 400;
        return e;
      };

      // Known program-specific messages
      if (
        errorMessage.includes('Error Code: TooLittleOutputReceived') ||
        errorMessage.includes('custom program error: 0x1786')
      ) {
        throw asBadRequest(
          'Swap failed: Slippage tolerance exceeded. Output would be less than your minimum. Consider increasing slippage.',
        );
      }
      if (
        errorMessage.includes('Error Code: TooMuchInputPaid') ||
        errorMessage.includes('custom program error: 0x1787')
      ) {
        throw asBadRequest(
          'Swap failed: Slippage tolerance exceeded. Input would be more than your maximum. Consider increasing slippage.',
        );
      }
      if (errorMessage.includes('SqrtPriceLimitOverflow') || errorMessage.includes('custom program error: 0x177d')) {
        throw asBadRequest(
          'Swap failed: Square root price limit overflow. Adjust price limit/direction or retry with default limits.',
        );
      }
      if (errorMessage.includes('InsufficientFunds') || errorMessage.toLowerCase().includes('insufficient')) {
        throw asBadRequest('Swap failed: Insufficient funds. Please check your token balance.');
      }
      if (errorMessage.includes('AccountNotFound')) {
        throw asBadRequest(
          'Swap failed: One or more required accounts not found. The pool or token accounts may not be initialized.',
        );
      }

      // Generic fallback
      logger.error('Transaction simulation failed:', simulationError);
      throw asBadRequest(
        'Transaction simulation failed. This usually means the swap parameters are invalid or market conditions changed. Try again.',
      );
    }
  }

  /**
   * Helper function to handle transaction confirmation results
   * Returns appropriate response object based on confirmation status
   * @param signature Transaction signature
   * @param confirmed Whether transaction was confirmed
   * @param txData Transaction data (if available)
   * @param tokenIn Input token address
   * @param tokenOut Output token address
   * @param walletAddress Wallet address for balance changes
   * @param side Trade side (optional, for AMM/CLMM swaps)
   * @returns Response object with status and data
   */
  public async handleConfirmation(
    signature: string,
    confirmed: boolean,
    txData: any,
    tokenIn: string,
    tokenOut: string,
    walletAddress: string,
    side?: 'BUY' | 'SELL',
  ): Promise<{
    signature: string;
    status: number;
    data?: {
      tokenIn: string;
      tokenOut: string;
      amountIn: number;
      amountOut: number;
      fee: number;
      baseTokenBalanceChange: number;
      quoteTokenBalanceChange: number;
    };
  }> {
    if (confirmed && txData) {
      // Transaction confirmed, extract balance changes
      const { balanceChanges, fee } = await this.extractBalanceChangesAndFee(signature, walletAddress, [
        tokenIn,
        tokenOut,
      ]);

      const inputTokenBalanceChange = balanceChanges[0];
      const outputTokenBalanceChange = balanceChanges[1];

      // Calculate actual amounts swapped
      const amountIn = Math.abs(inputTokenBalanceChange);
      const amountOut = Math.abs(outputTokenBalanceChange);

      // For AMM/CLMM swaps with side information
      let baseTokenBalanceChange: number | undefined;
      let quoteTokenBalanceChange: number | undefined;

      if (side) {
        // For AMM/CLMM swaps, determine base/quote changes based on side
        baseTokenBalanceChange = side === 'SELL' ? inputTokenBalanceChange : outputTokenBalanceChange;
        quoteTokenBalanceChange = side === 'SELL' ? outputTokenBalanceChange : inputTokenBalanceChange;
      } else {
        // For router swaps, use raw balance changes
        baseTokenBalanceChange = inputTokenBalanceChange;
        quoteTokenBalanceChange = outputTokenBalanceChange;
      }

      return {
        signature,
        status: 1, // CONFIRMED
        data: {
          tokenIn,
          tokenOut,
          amountIn,
          amountOut,
          fee,
          baseTokenBalanceChange: baseTokenBalanceChange!,
          quoteTokenBalanceChange: quoteTokenBalanceChange!,
        },
      };
    } else if (txData && !confirmed) {
      // Transaction exists but not confirmed - extract fee from txData
      const fee = this.getFee(txData);

      logger.warn(`Transaction ${signature} not confirmed. May need higher priority fee.`);

      return {
        signature,
        status: -1, // NOT_CONFIRMED
        data: {
          tokenIn,
          tokenOut,
          amountIn: 0,
          amountOut: 0,
          fee,
          baseTokenBalanceChange: 0,
          quoteTokenBalanceChange: 0,
        },
      };
    } else {
      // Transaction pending, no data available
      logger.warn(`Transaction ${signature} pending. No transaction data available.`);

      return {
        signature,
        status: 0, // PENDING
        data: undefined,
      };
    }
  }

  /**
   * Create instructions to wrap native SOL to WSOL
   * @param walletPubkey Wallet public key
   * @param amount Amount of SOL to wrap in lamports
   * @param tokenProgram Token program (default TOKEN_PROGRAM_ID)
   * @returns Array of instructions to wrap SOL
   */
  public async wrapSOL(
    walletPubkey: PublicKey,
    amount: number,
    tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
  ): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];
    const wsolAccount = getAssociatedTokenAddressSync(NATIVE_MINT, walletPubkey, false, tokenProgram);

    // Check if WSOL account exists
    const accountInfo = await this.connection.getAccountInfo(wsolAccount);

    if (!accountInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(walletPubkey, wsolAccount, walletPubkey, NATIVE_MINT, tokenProgram),
      );
    }

    // Transfer SOL and sync
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: walletPubkey,
        toPubkey: wsolAccount,
        lamports: amount,
      }),
    );
    instructions.push(createSyncNativeInstruction(wsolAccount, tokenProgram));

    return instructions;
  }

  /**
   * Create instruction to unwrap WSOL back to native SOL
   * @param walletPubkey Wallet public key
   * @param tokenProgram Token program (default TOKEN_PROGRAM_ID)
   * @returns Instruction to close WSOL account and return SOL
   */
  public unwrapSOL(walletPubkey: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): TransactionInstruction {
    const wsolAccount = getAssociatedTokenAddressSync(NATIVE_MINT, walletPubkey, false, tokenProgram);
    return createCloseAccountInstruction(wsolAccount, walletPubkey, walletPubkey, [], tokenProgram);
  }

  /**
   * Clean up resources including WebSocket connections and connection warming
   */
  public disconnect(): void {
    if (this.heliusService) {
      this.heliusService.disconnect();
      logger.info('Helius services disconnected and cleaned up');
    }
  }

  /**
   * Static method to clean up all instances
   */
  public static disconnectAll(): void {
    if (Solana._instances) {
      for (const instance of Object.values(Solana._instances)) {
        instance.disconnect();
      }
    }
  }
}
