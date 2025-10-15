import { Provider } from '@ethersproject/abstract-provider';
import { BigNumber, Contract, ContractTransaction, providers, utils, Wallet, ethers } from 'ethers';
import { getAddress } from 'ethers/lib/utils';
import fse from 'fs-extra';

import { TokenValue, tokenValueToString } from '../../services/base';
import { ConfigManagerCertPassphrase } from '../../services/config-manager-cert-passphrase';
import { ConfigManagerV2 } from '../../services/config-manager-v2';
import { logger } from '../../services/logger';
import { TokenService } from '../../services/token-service';
import { walletPath, isHardwareWallet as checkIsHardwareWallet } from '../../wallet/utils';

import { getEthereumNetworkConfig, getEthereumChainConfig } from './ethereum.config';
import { EtherscanService } from './etherscan-service';
import { InfuraService } from './infura-service';

// information about an Ethereum token
export interface TokenInfo {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

export type NewBlockHandler = (bn: number) => void;
export type NewDebugMsgHandler = (msg: any) => void;

export class Ethereum {
  private static _instances: { [name: string]: Ethereum };
  public provider: providers.StaticJsonRpcProvider;
  public tokenList: TokenInfo[] = [];
  public tokenMap: Record<string, TokenInfo> = {};
  public network: string;
  public nativeTokenSymbol: string;
  public chainId: number;
  public rpcUrl: string;
  public minGasPrice: number;
  public maxFeePerGas?: number;
  public maxPriorityFeePerGas?: number;
  private _initialized: boolean = false;
  private infuraService?: InfuraService;
  private etherscanService?: EtherscanService;

  private static lastGasPriceEstimate: {
    timestamp: number;
    gasPrice: number;
    maxFeePerGas?: number;
    maxPriorityFeePerGas?: number;
    isEIP1559?: boolean;
  } | null = null;
  private static GAS_PRICE_CACHE_MS = 10000; // 10 second cache

  // For backward compatibility
  public get chain(): string {
    return this.network;
  }

  private constructor(network: string) {
    const config = getEthereumNetworkConfig(network);
    this.chainId = config.chainID;
    this.rpcUrl = config.nodeURL;
    this.network = network;
    this.nativeTokenSymbol = config.nativeCurrencySymbol;
    this.minGasPrice = config.minGasPrice || 0.1; // Default to 0.1 GWEI if not specified
    this.maxFeePerGas = config.maxFeePerGas;
    this.maxPriorityFeePerGas = config.maxPriorityFeePerGas;

    // Get chain config for etherscanAPIKey
    const chainConfig = getEthereumChainConfig();

    // Initialize Etherscan service if API key is provided and chain is supported
    if (chainConfig.etherscanAPIKey && EtherscanService.isSupported(this.chainId)) {
      try {
        this.etherscanService = new EtherscanService(this.chainId, network, chainConfig.etherscanAPIKey);
        logger.info(
          `✅ Etherscan V2 API configured for ${network} (chainId: ${this.chainId}, key length: ${chainConfig.etherscanAPIKey.length} chars)`,
        );
      } catch (error: any) {
        logger.warn(`Failed to initialize Etherscan service: ${error.message}`);
      }
    }

    // Get rpcProvider from chain config
    const rpcProvider = chainConfig.rpcProvider || 'url';

    // Initialize RPC connection based on provider
    if (rpcProvider === 'infura') {
      logger.info(`Initializing Infura services for provider: ${rpcProvider}`);
      this.initializeInfuraProvider(config);
    } else {
      logger.info(`Using standard RPC provider: ${rpcProvider}`);
      logger.info(`Initializing Ethereum connector for network: ${network}, RPC URL: ${this.rpcUrl}`);
      this.provider = new providers.StaticJsonRpcProvider(this.rpcUrl);
    }
  }

  public static async getInstance(network: string): Promise<Ethereum> {
    if (!Ethereum._instances) {
      Ethereum._instances = {};
    }
    if (!Ethereum._instances[network]) {
      const instance = new Ethereum(network);
      await instance.init();
      Ethereum._instances[network] = instance;
    }
    return Ethereum._instances[network];
  }

  public static getConnectedInstances(): { [name: string]: Ethereum } {
    return Ethereum._instances;
  }

  public onNewBlock(func: NewBlockHandler) {
    this.provider.on('block', func);
  }

  public onDebugMessage(func: NewDebugMsgHandler) {
    this.provider.on('debug', func);
  }

  /**
   * Check if the Ethereum instance is ready
   */
  public ready(): boolean {
    return this._initialized;
  }

  /**
   * Estimates the current gas price
   * Returns the gas price in GWEI
   */
  public async estimateGasPrice(): Promise<number> {
    // Check cache first
    if (
      Ethereum.lastGasPriceEstimate &&
      Date.now() - Ethereum.lastGasPriceEstimate.timestamp < Ethereum.GAS_PRICE_CACHE_MS
    ) {
      return Ethereum.lastGasPriceEstimate.gasPrice;
    }

    // Check if the network supports EIP-1559
    const supportsEIP1559 =
      this.network === 'mainnet' ||
      this.network === 'polygon' ||
      this.network === 'arbitrum' ||
      this.network === 'optimism' ||
      this.network === 'base';

    if (supportsEIP1559) {
      try {
        let maxFeePerGasGwei: number;
        let maxPriorityFeePerGasGwei: number;
        let networkMaxFeeGwei: number | undefined;
        let networkPriorityFeeGwei: number | undefined;
        let networkBaseFeeGwei: number | undefined;

        // Try to fetch from Etherscan API first if available
        if (this.etherscanService) {
          try {
            const gasPrices = await this.etherscanService.getRecommendedGasPrices('propose');
            networkMaxFeeGwei = gasPrices.maxFeePerGas;
            networkPriorityFeeGwei = gasPrices.maxPriorityFeePerGas;
            // Estimate baseFee from the formula: baseFee ≈ (maxFee - priority) / 2
            networkBaseFeeGwei = (networkMaxFeeGwei - networkPriorityFeeGwei) / 2;
            logger.info(
              `Etherscan API EIP-1559 fees: baseFee≈${networkBaseFeeGwei.toFixed(4)} GWEI, maxFee=${networkMaxFeeGwei.toFixed(4)} GWEI, priority=${networkPriorityFeeGwei.toFixed(4)} GWEI`,
            );
          } catch (scanError: any) {
            logger.warn(`Failed to fetch from Etherscan API: ${scanError.message}, falling back to RPC`);
          }
        }

        // Fallback to RPC provider if Etherscan not available or failed
        if (networkMaxFeeGwei === undefined || networkPriorityFeeGwei === undefined) {
          try {
            const feeData = await this.provider.getFeeData();
            if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
              const block = await this.provider.getBlock('latest');
              const baseFee = block.baseFeePerGas || BigNumber.from('0');

              // Calculate recommended maxFeePerGas as 2 * baseFee + maxPriorityFeePerGas
              const recommendedMaxFee = baseFee.mul(2).add(feeData.maxPriorityFeePerGas);
              const maxFeePerGas = feeData.maxFeePerGas.gt(recommendedMaxFee)
                ? feeData.maxFeePerGas
                : recommendedMaxFee;

              networkBaseFeeGwei = parseFloat(utils.formatUnits(baseFee, 'gwei'));
              networkMaxFeeGwei = parseFloat(utils.formatUnits(maxFeePerGas, 'gwei'));
              networkPriorityFeeGwei = parseFloat(utils.formatUnits(feeData.maxPriorityFeePerGas, 'gwei'));

              logger.info(
                `Network RPC EIP-1559 fees: baseFee=${networkBaseFeeGwei.toFixed(4)} GWEI, maxFee=${networkMaxFeeGwei.toFixed(4)} GWEI, priority=${networkPriorityFeeGwei.toFixed(4)} GWEI`,
              );
            }
          } catch (networkError: any) {
            logger.warn(`Failed to fetch network EIP-1559 data: ${networkError.message}`);
          }
        }

        // Use configured values if available, otherwise use network values
        if (this.maxFeePerGas !== undefined && this.maxPriorityFeePerGas !== undefined) {
          maxFeePerGasGwei = this.maxFeePerGas;
          maxPriorityFeePerGasGwei = this.maxPriorityFeePerGas;
          logger.info(
            `Using configured EIP-1559 fees: maxFee=${maxFeePerGasGwei} GWEI, priority=${maxPriorityFeePerGasGwei} GWEI`,
          );
        } else if (networkMaxFeeGwei !== undefined && networkPriorityFeeGwei !== undefined) {
          // Use network values
          maxFeePerGasGwei = networkMaxFeeGwei;
          maxPriorityFeePerGasGwei = networkPriorityFeeGwei;
          logger.info(
            `Using network EIP-1559 fees: maxFee=${maxFeePerGasGwei.toFixed(4)} GWEI, priority=${maxPriorityFeePerGasGwei.toFixed(4)} GWEI`,
          );
        } else {
          throw new Error('EIP-1559 fee data not available from network or config');
        }

        // Apply minimum gas price
        const minGasPrice = this.minGasPrice;
        if (maxFeePerGasGwei < minGasPrice) {
          logger.info(
            `Using configured minimum gas price. Current maxFee: ${maxFeePerGasGwei} GWEI, Minimum: ${minGasPrice} GWEI`,
          );
          maxFeePerGasGwei = minGasPrice;
        }

        // Cache the result
        Ethereum.lastGasPriceEstimate = {
          timestamp: Date.now(),
          gasPrice: maxFeePerGasGwei,
          maxFeePerGas: maxFeePerGasGwei,
          maxPriorityFeePerGas: maxPriorityFeePerGasGwei,
          isEIP1559: true,
        };

        logger.info(`Estimated: ${maxFeePerGasGwei} GWEI for network ${this.network}`);
        return maxFeePerGasGwei;
      } catch (error: any) {
        logger.warn(`Failed to get EIP-1559 fee data, falling back to legacy pricing: ${error.message}`);
      }
    }

    // Legacy gas price estimation
    try {
      const baseFee: BigNumber = await this.provider.getGasPrice();
      let priorityFee: BigNumber = BigNumber.from('0');
      // Only get priority fee for mainnet
      if (this.network === 'mainnet') {
        priorityFee = BigNumber.from(await this.provider.send('eth_maxPriorityFeePerGas', []));
      }

      const baseWithPriority = baseFee.add(priorityFee);
      const networkGasPriceGwei = baseWithPriority.toNumber() * 1e-9;

      // Always log the network gas price
      logger.info(`Network legacy gas price: ${networkGasPriceGwei.toFixed(4)} GWEI`);

      // Apply minimum gas price for all networks
      const minGasPriceWei = utils.parseUnits(this.minGasPrice.toString(), 'gwei');

      // Use the larger of the current gas price or the configured minimum
      const adjustedFee = baseWithPriority.lt(minGasPriceWei) ? minGasPriceWei : baseWithPriority;

      if (baseWithPriority.lt(minGasPriceWei)) {
        logger.info(
          `Using configured minimum gas price: ${this.minGasPrice} GWEI (network: ${networkGasPriceGwei.toFixed(4)} GWEI)`,
        );
      } else {
        logger.info(`Using network gas price: ${networkGasPriceGwei.toFixed(4)} GWEI`);
      }

      const totalFeeGwei = adjustedFee.toNumber() * 1e-9;
      logger.info(`Estimated: ${totalFeeGwei} GWEI for network ${this.network}`);

      // Cache the result
      Ethereum.lastGasPriceEstimate = {
        timestamp: Date.now(),
        gasPrice: totalFeeGwei,
        isEIP1559: false,
      };

      return totalFeeGwei;
    } catch (error: any) {
      logger.error(`Failed to estimate gas price: ${error.message}`);
      return this.minGasPrice; // Return minimum gas price as fallback
    }
  }

  /**
   * Prepare gas options for a transaction
   * @param gasPrice Gas price in Gwei (optional, uses cached estimate if not provided)
   * @param gasLimit Gas limit (optional, defaults to 300000)
   * @returns Gas options object for ethers.js transaction
   */
  public async prepareGasOptions(gasPrice?: number, gasLimit?: number): Promise<any> {
    const gasOptions: any = {};

    // Set default gas limit if not provided
    const DEFAULT_GAS_LIMIT = 300000;
    gasOptions.gasLimit = gasLimit ?? DEFAULT_GAS_LIMIT;

    // Check if the network supports EIP-1559
    const supportsEIP1559 =
      this.network === 'mainnet' ||
      this.network === 'polygon' ||
      this.network === 'arbitrum' ||
      this.network === 'optimism' ||
      this.network === 'base';

    if (supportsEIP1559) {
      // Use cached EIP-1559 values from estimateGasPrice if available and gasPrice not explicitly provided
      if (
        !gasPrice &&
        Ethereum.lastGasPriceEstimate?.isEIP1559 &&
        Ethereum.lastGasPriceEstimate?.maxFeePerGas !== undefined &&
        Ethereum.lastGasPriceEstimate?.maxPriorityFeePerGas !== undefined
      ) {
        gasOptions.type = 2;
        gasOptions.maxFeePerGas = utils.parseUnits(Ethereum.lastGasPriceEstimate.maxFeePerGas.toString(), 'gwei');
        gasOptions.maxPriorityFeePerGas = utils.parseUnits(
          Ethereum.lastGasPriceEstimate.maxPriorityFeePerGas.toString(),
          'gwei',
        );

        logger.info(
          `Using cached EIP-1559 pricing: maxFee=${Ethereum.lastGasPriceEstimate.maxFeePerGas} GWEI, priority=${Ethereum.lastGasPriceEstimate.maxPriorityFeePerGas} GWEI`,
        );
        return gasOptions;
      }

      // If gasPrice is provided, use it as maxFeePerGas with a default priority fee
      if (gasPrice) {
        const priorityFee = this.maxPriorityFeePerGas || 0.01; // Default 0.01 GWEI priority fee
        gasOptions.type = 2;
        gasOptions.maxFeePerGas = utils.parseUnits(gasPrice.toString(), 'gwei');
        gasOptions.maxPriorityFeePerGas = utils.parseUnits(priorityFee.toString(), 'gwei');

        logger.info(
          `Using EIP-1559 pricing with provided gasPrice: maxFee=${gasPrice} GWEI, priority=${priorityFee} GWEI`,
        );
        return gasOptions;
      }

      // If no cached values and no gasPrice provided, call estimateGasPrice to fetch/cache values
      logger.warn('No cached EIP-1559 data available, calling estimateGasPrice()');
      await this.estimateGasPrice();

      // Try again with newly cached values
      if (
        Ethereum.lastGasPriceEstimate?.isEIP1559 &&
        Ethereum.lastGasPriceEstimate?.maxFeePerGas !== undefined &&
        Ethereum.lastGasPriceEstimate?.maxPriorityFeePerGas !== undefined
      ) {
        gasOptions.type = 2;
        gasOptions.maxFeePerGas = utils.parseUnits(Ethereum.lastGasPriceEstimate.maxFeePerGas.toString(), 'gwei');
        gasOptions.maxPriorityFeePerGas = utils.parseUnits(
          Ethereum.lastGasPriceEstimate.maxPriorityFeePerGas.toString(),
          'gwei',
        );

        logger.info(
          `Using newly fetched EIP-1559 pricing: maxFee=${Ethereum.lastGasPriceEstimate.maxFeePerGas} GWEI, priority=${Ethereum.lastGasPriceEstimate.maxPriorityFeePerGas} GWEI`,
        );
        return gasOptions;
      }
    }

    // Fallback to legacy gas pricing (type 0)
    const gasPriceInGwei = gasPrice ?? (await this.estimateGasPrice());
    gasOptions.type = 0;
    gasOptions.gasPrice = utils.parseUnits(gasPriceInGwei.toString(), 'gwei');
    logger.info(`Using legacy gas pricing: ${gasPriceInGwei} GWEI with gasLimit: ${gasOptions.gasLimit}`);

    return gasOptions;
  }

  /**
   * Get a contract instance for a token using standard ERC20 interface
   */
  public getContract(tokenAddress: string, signerOrProvider?: Wallet | Provider): Contract {
    // Standard ERC20 interface ABI - the minimum needed for our operations
    const erc20Interface = [
      'function name() view returns (string)',
      'function symbol() view returns (string)',
      'function decimals() view returns (uint8)',
      'function totalSupply() view returns (uint256)',
      'function balanceOf(address owner) view returns (uint256)',
      'function transfer(address to, uint256 amount) returns (bool)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
      'function transferFrom(address from, address to, uint256 amount) returns (bool)',
      'event Transfer(address indexed from, address indexed to, uint256 amount)',
      'event Approval(address indexed owner, address indexed spender, uint256 amount)',
    ];

    return new Contract(tokenAddress, erc20Interface, signerOrProvider || this.provider);
  }

  /**
   * Initialize Infura provider with configuration
   */
  private initializeInfuraProvider(config: any): void {
    try {
      const configManager = ConfigManagerV2.getInstance();
      const infuraApiKey = configManager.get('infura.apiKey') || '';
      const useWebSocket = configManager.get('infura.useWebSocket') || false;

      if (!infuraApiKey || infuraApiKey.trim() === '') {
        logger.warn(`⚠️ Infura provider selected but no API key configured, falling back to standard RPC`);
        this.provider = new providers.StaticJsonRpcProvider(this.rpcUrl);
        return;
      }

      // Merge configs for InfuraService
      const mergedConfig = {
        ...config,
        infuraAPIKey: infuraApiKey,
        useInfuraWebSocket: useWebSocket,
      };

      logger.info(`✅ Infura API key configured (length: ${infuraApiKey.length} chars)`);
      logger.info(`Infura features enabled - WebSocket: ${useWebSocket}`);

      this.infuraService = new InfuraService(mergedConfig);
      this.provider = this.infuraService.getProvider() as providers.StaticJsonRpcProvider;
    } catch (error: any) {
      logger.warn(`Failed to initialize Infura provider: ${error.message}, falling back to standard RPC`);
      this.provider = new providers.StaticJsonRpcProvider(this.rpcUrl);
    }
  }

  /**
   * Initialize the Ethereum connector
   */
  public async init(): Promise<void> {
    try {
      await this.loadTokens();
      this._initialized = true;
    } catch (e) {
      logger.error(`Failed to initialize Ethereum chain: ${e}`);
      throw e;
    }
  }

  /**
   * Load tokens from the token list source
   */
  public async loadTokens(): Promise<void> {
    logger.info(`Loading tokens for ethereum/${this.network} using TokenService`);
    try {
      // Use TokenService to load tokens
      const tokens = await TokenService.getInstance().loadTokenList('ethereum', this.network);

      // Convert to TokenInfo format with chainId and normalize addresses
      this.tokenList = tokens.map((token) => ({
        ...token,
        address: getAddress(token.address), // Normalize to checksummed address
        chainId: this.chainId,
      }));

      if (this.tokenList) {
        logger.info(`Loaded ${this.tokenList.length} tokens for ethereum/${this.network}`);
        // Build token map for faster lookups
        this.tokenList.forEach((token: TokenInfo) => (this.tokenMap[token.symbol] = token));
      }
    } catch (error) {
      logger.error(`Failed to load token list: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all tokens loaded from the token list
   */
  public get storedTokenList(): TokenInfo[] {
    return Object.values(this.tokenMap);
  }

  /**
   * Get token info by symbol or address
   */
  public getToken(tokenSymbol: string): TokenInfo | undefined {
    // First try to find token by symbol
    const tokenBySymbol = this.tokenList.find(
      (token: TokenInfo) => token.symbol.toUpperCase() === tokenSymbol.toUpperCase() && token.chainId === this.chainId,
    );

    if (tokenBySymbol) {
      return tokenBySymbol;
    }

    // If not found by symbol, check if it's a valid address
    try {
      const normalizedAddress = utils.getAddress(tokenSymbol);
      // Try to find token by normalized address
      return this.tokenList.find(
        (token: TokenInfo) =>
          token.address.toLowerCase() === normalizedAddress.toLowerCase() && token.chainId === this.chainId,
      );
    } catch {
      // If not a valid address format, return undefined
      return undefined;
    }
  }

  /**
   * Get multiple tokens and return a map with symbols as keys
   * This helper function is used by routes like allowances and balances
   * @param tokens Array of token symbols or addresses
   * @returns Map of token symbol to TokenInfo for found tokens
   */
  public getTokensAsMap(tokens: string[]): Record<string, TokenInfo> {
    const tokenMap: Record<string, TokenInfo> = {};

    for (const symbolOrAddress of tokens) {
      const tokenInfo = this.getToken(symbolOrAddress);
      if (tokenInfo) {
        // Use the actual token symbol as the key, not the input which might be an address
        tokenMap[tokenInfo.symbol] = tokenInfo;
      }
    }

    return tokenMap;
  }

  /**
   * Create a wallet from a private key
   */
  public getWalletFromPrivateKey(privateKey: string): Wallet {
    return new Wallet(privateKey, this.provider);
  }

  /**
   * Validate Ethereum address format
   * @param address The address to validate
   * @returns The checksummed address if valid
   * @throws Error if the address is invalid
   */
  public static validateAddress(address: string): string {
    try {
      // getAddress will both validate the address format and return a checksummed version
      return getAddress(address);
    } catch (error) {
      throw new Error(`Invalid Ethereum address format: ${address}`);
    }
  }

  public async getWallet(address: string): Promise<Wallet> {
    try {
      // Validate the address format first
      const validatedAddress = Ethereum.validateAddress(address);

      const path = `${walletPath}/ethereum`;
      const encryptedPrivateKey = await fse.readFile(`${path}/${validatedAddress}.json`, 'utf8');

      const passphrase = ConfigManagerCertPassphrase.readPassphrase();
      if (!passphrase) {
        throw new Error('Missing passphrase');
      }
      return await this.decrypt(encryptedPrivateKey, passphrase);
    } catch (error) {
      if (error.message.includes('Invalid Ethereum address')) {
        throw error; // Re-throw validation errors
      }
      if (error.code === 'ENOENT') {
        throw new Error(`Wallet not found for address: ${address}`);
      }
      throw error;
    }
  }

  /**
   * Get the first available Ethereum wallet address
   */
  public static async getFirstWalletAddress(): Promise<string | null> {
    const path = `${walletPath}/ethereum`;
    try {
      // Create directory if it doesn't exist
      await fse.ensureDir(path);

      // Get all .json files in the directory
      const files = await fse.readdir(path);
      const walletFiles = files.filter((f) => f.endsWith('.json'));

      if (walletFiles.length === 0) {
        return null;
      }

      // Get the first wallet address (without .json extension)
      const walletAddress = walletFiles[0].slice(0, -5);

      try {
        // Attempt to validate the address
        return Ethereum.validateAddress(walletAddress);
      } catch (e) {
        logger.warn(`Invalid Ethereum address found in wallet directory: ${walletAddress}`);
        return null;
      }
    } catch (err) {
      return null;
    }
  }

  /**
   * Get the InfuraService instance if initialized
   */
  public getInfuraService(): InfuraService | null {
    return this.infuraService || null;
  }

  /**
   * Check if an address is a hardware wallet
   */
  public async isHardwareWallet(address: string): Promise<boolean> {
    try {
      return await checkIsHardwareWallet('ethereum', address);
    } catch (error) {
      logger.error(`Error checking hardware wallet status: ${error.message}`);
      return false;
    }
  }

  /**
   * Encrypt a private key
   */
  public encrypt(privateKey: string, password: string): Promise<string> {
    const wallet = this.getWalletFromPrivateKey(privateKey);
    return wallet.encrypt(password);
  }

  /**
   * Decrypt an encrypted private key
   */
  public async decrypt(encryptedPrivateKey: string, password: string): Promise<Wallet> {
    const wallet = await Wallet.fromEncryptedJson(encryptedPrivateKey, password);
    return wallet.connect(this.provider);
  }

  /**
   * Get native token balance
   */
  public async getNativeBalance(wallet: Wallet): Promise<TokenValue> {
    const balance = await wallet.getBalance();
    return { value: balance, decimals: 18 };
  }

  /**
   * Get native token balance by address
   */
  public async getNativeBalanceByAddress(address: string): Promise<TokenValue> {
    const balance = await this.provider.getBalance(address);
    return { value: balance, decimals: 18 };
  }

  /**
   * Get ERC-20 token balance
   */
  public async getERC20Balance(
    contract: Contract,
    wallet: Wallet,
    decimals: number,
    timeoutMs: number = 5000, // Default 5 second timeout
    tokenSymbol?: string, // Optional token symbol for logging
  ): Promise<TokenValue> {
    // Add timeout to prevent hanging on problematic tokens
    const balancePromise = contract.balanceOf(wallet.address);

    // Create a timeout promise that rejects after specified timeout
    const timeoutPromise = new Promise<BigNumber>((_, reject) => {
      setTimeout(() => {
        reject(new Error('Token balance request timed out'));
      }, timeoutMs);
    });

    // Race the balance request against the timeout
    const balance: BigNumber = await Promise.race([balancePromise, timeoutPromise]);

    if (tokenSymbol) {
      logger.debug(`Token balance for ${tokenSymbol}: ${balance.toString()}`);
    }
    return { value: balance, decimals: decimals };
  }

  /**
   * Get ERC-20 token balance by address
   */
  public async getERC20BalanceByAddress(
    contract: Contract,
    address: string,
    decimals: number,
    timeoutMs: number = 5000, // Default 5 second timeout
    tokenSymbol?: string, // Optional token symbol for logging
  ): Promise<TokenValue> {
    // Add timeout to prevent hanging on problematic tokens
    const balancePromise = contract.balanceOf(address);

    // Create a timeout promise that rejects after specified timeout
    const timeoutPromise = new Promise<BigNumber>((_, reject) => {
      setTimeout(() => {
        reject(new Error('Token balance request timed out'));
      }, timeoutMs);
    });

    // Race the balance request against the timeout
    const balance: BigNumber = await Promise.race([balancePromise, timeoutPromise]);

    if (tokenSymbol) {
      logger.debug(`Token balance for ${tokenSymbol}: ${balance.toString()}`);
    }
    return { value: balance, decimals: decimals };
  }

  /**
   * Get ERC-20 token allowance
   */
  public async getERC20Allowance(
    contract: Contract,
    wallet: Wallet,
    spender: string,
    decimals: number,
  ): Promise<TokenValue> {
    const allowance = await contract.allowance(wallet.address, spender);
    return { value: allowance, decimals: decimals };
  }

  /**
   * Get ERC-20 token allowance by address
   */
  public async getERC20AllowanceByAddress(
    contract: Contract,
    ownerAddress: string,
    spender: string,
    decimals: number,
  ): Promise<TokenValue> {
    const allowance = await contract.allowance(ownerAddress, spender);
    return { value: allowance, decimals: decimals };
  }

  /**
   * Get transaction details
   */
  public async getTransaction(txHash: string): Promise<providers.TransactionResponse> {
    return this.provider.getTransaction(txHash);
  }

  /**
   * Get transaction receipt directly
   */
  public async getTransactionReceipt(txHash: string): Promise<providers.TransactionReceipt | null> {
    return this.provider.getTransactionReceipt(txHash);
  }

  /**
   * Approve ERC-20 token spending
   */
  public async approveERC20(
    contract: Contract,
    wallet: Wallet,
    spender: string,
    amount: BigNumber,
  ): Promise<providers.TransactionResponse> {
    logger.info(`Approving ${amount.toString()} tokens for spender ${spender}`);

    // Prepare gas options for approval transaction
    const gasOptions = await this.prepareGasOptions();
    const params: any = {
      ...gasOptions,
      nonce: await this.provider.getTransactionCount(wallet.address),
    };

    // Don't add gasPrice when using EIP-1559 parameters
    return contract.approve(spender, amount, params);
  }

  /**
   * Get current block number
   */
  public async getCurrentBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /**
   * Close the Ethereum connector and clean up resources
   */
  public async close() {
    if (this.network in Ethereum._instances) {
      delete Ethereum._instances[this.network];
    }
  }

  // WETH ABI for wrap/unwrap operations
  private static WETH9ABI = [
    // Standard ERC20 functions
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address owner) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',

    // WETH-specific functions
    'function deposit() public payable',
    'function withdraw(uint256 amount) public',
  ];

  // Define wrapped native token addresses for different networks
  private static WRAPPED_ADDRESSES: {
    [key: string]: { address: string; symbol: string; nativeSymbol: string };
  } = {
    mainnet: {
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      symbol: 'WETH',
      nativeSymbol: 'ETH',
    },
    arbitrum: {
      address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      symbol: 'WETH',
      nativeSymbol: 'ETH',
    },
    optimism: {
      address: '0x4200000000000000000000000000000000000006',
      symbol: 'WETH',
      nativeSymbol: 'ETH',
    },
    base: {
      address: '0x4200000000000000000000000000000000000006',
      symbol: 'WETH',
      nativeSymbol: 'ETH',
    },
    sepolia: {
      address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
      symbol: 'WETH',
      nativeSymbol: 'ETH',
    },
    polygon: {
      address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
      symbol: 'WETH',
      nativeSymbol: 'MATIC',
    },
    bsc: {
      address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      symbol: 'WBNB',
      nativeSymbol: 'BNB',
    },
    avalanche: {
      address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
      symbol: 'WAVAX',
      nativeSymbol: 'AVAX',
    },
    celo: {
      address: '0x471EcE3750Da237f93B8E339c536989b8978a438',
      symbol: 'WCELO',
      nativeSymbol: 'CELO',
    },
  };

  /**
   * Get the wrapped token (WETH, WBNB, etc.) address for the current network
   * @returns The address of the wrapped token
   */
  public getWrappedNativeTokenAddress(): string {
    const wrappedInfo = Ethereum.WRAPPED_ADDRESSES[this.network];
    if (!wrappedInfo) {
      throw new Error(`Wrapped token address not found for network: ${this.network}`);
    }
    return wrappedInfo.address;
  }

  /**
   * Check if a token is the wrapped native token (WETH, WBNB, etc.)
   * @param tokenAddress The token address to check
   * @returns True if the token is the wrapped native token
   */
  public isWrappedNativeToken(tokenAddress: string): boolean {
    const wrappedAddress = this.getWrappedNativeTokenAddress();
    return tokenAddress.toLowerCase() === wrappedAddress.toLowerCase();
  }

  /**
   * Wraps native ETH to WETH (or equivalent on other chains)
   * @param wallet The wallet to use for wrapping
   * @param amountInWei The amount of ETH to wrap in wei (as a BigNumber)
   * @returns The transaction receipt
   */
  public async wrapNativeToken(wallet: Wallet, amountInWei: BigNumber): Promise<ContractTransaction> {
    const wrappedAddress = this.getWrappedNativeTokenAddress();

    // Create wrapped token contract instance
    const wrappedContract = new Contract(wrappedAddress, Ethereum.WETH9ABI, wallet);

    // Prepare gas options for wrap transaction
    const gasOptions = await this.prepareGasOptions();
    const params: any = {
      ...gasOptions,
      nonce: await this.provider.getTransactionCount(wallet.address),
      value: amountInWei, // Send native token with the transaction
    };

    // Don't add gasPrice when using EIP-1559 parameters
    // Create transaction to call deposit() function
    logger.info(`Wrapping ${utils.formatEther(amountInWei)} ETH to WETH`);
    return await wrappedContract.deposit(params);
  }

  /**
   * Get a wallet address example for schema documentation
   */
  public static async getWalletAddressExample(): Promise<string> {
    const chainConfig = getEthereumChainConfig();
    return chainConfig.defaultWallet;
  }

  // Check if the address is a valid EVM address
  public static isAddress(address: string): boolean {
    return ethers.utils.isAddress(address);
  }

  /**
   * Handle transaction confirmation status and return appropriate response
   * Similar to Solana's handleConfirmation helper
   * @param txReceipt Transaction receipt
   * @param inputToken Input token address
   * @param outputToken Output token address
   * @param expectedAmountIn Expected input amount
   * @param expectedAmountOut Expected output amount
   * @param side Trade side (optional)
   * @returns Response object with status and data
   */
  public handleTransactionConfirmation(
    txReceipt: providers.TransactionReceipt | null,
    inputToken: string,
    outputToken: string,
    expectedAmountIn: number,
    expectedAmountOut: number,
    side?: 'BUY' | 'SELL',
  ): {
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
  } {
    if (!txReceipt) {
      // Transaction receipt not available - still pending
      logger.warn('Transaction pending, no receipt available yet');
      return {
        signature: '',
        status: 0, // PENDING
        data: undefined,
      };
    }

    const signature = txReceipt.transactionHash;

    if (txReceipt.status === 0) {
      // Transaction failed on-chain
      logger.error(`Transaction ${signature} failed on-chain`);
      return {
        signature,
        status: -1, // FAILED
        data: {
          tokenIn: inputToken,
          tokenOut: outputToken,
          amountIn: 0,
          amountOut: 0,
          fee: 0,
          baseTokenBalanceChange: 0,
          quoteTokenBalanceChange: 0,
        },
      };
    }

    if (txReceipt.status === 1) {
      // Transaction confirmed successfully
      // Calculate fee from gas used
      const fee = parseFloat(txReceipt.gasUsed.mul(txReceipt.effectiveGasPrice).toString()) / 1e18;

      // Calculate balance changes based on side
      let baseTokenBalanceChange: number;
      let quoteTokenBalanceChange: number;

      if (side) {
        // For AMM/CLMM swaps with side information
        baseTokenBalanceChange = side === 'SELL' ? -expectedAmountIn : expectedAmountOut;
        quoteTokenBalanceChange = side === 'SELL' ? expectedAmountOut : -expectedAmountIn;
      } else {
        // For router swaps without side information
        baseTokenBalanceChange = -expectedAmountIn;
        quoteTokenBalanceChange = expectedAmountOut;
      }

      return {
        signature,
        status: 1, // CONFIRMED
        data: {
          tokenIn: inputToken,
          tokenOut: outputToken,
          amountIn: expectedAmountIn,
          amountOut: expectedAmountOut,
          fee,
          baseTokenBalanceChange,
          quoteTokenBalanceChange,
        },
      };
    }

    // Transaction is still pending (ethers returns status as undefined in some cases)
    logger.warn(`Transaction ${signature} status unclear, treating as pending`);
    return {
      signature,
      status: 0, // PENDING
      data: {
        tokenIn: inputToken,
        tokenOut: outputToken,
        amountIn: 0,
        amountOut: 0,
        fee: 0,
        baseTokenBalanceChange: 0,
        quoteTokenBalanceChange: 0,
      },
    };
  }

  /**
   * Get all token balances for an address
   * @param address Wallet address
   * @param tokens Optional array of token symbols/addresses to fetch. If not provided, fetches all tokens in token list
   * @returns Map of token symbol to balance
   */
  public async getBalances(address: string, tokens?: string[]): Promise<Record<string, number>> {
    const balances: Record<string, number> = {};

    // Treat empty array as if no tokens were specified
    const effectiveTokens = tokens && tokens.length === 0 ? undefined : tokens;

    // Check if this is a hardware wallet
    const isHardware = await this.isHardwareWallet(address);
    let wallet: Wallet | null = null;

    if (!isHardware) {
      wallet = await this.getWallet(address);
    }

    // Always get native token balance
    const nativeBalance = isHardware
      ? await this.getNativeBalanceByAddress(address)
      : await this.getNativeBalance(wallet!);
    balances[this.nativeTokenSymbol] = parseFloat(tokenValueToString(nativeBalance));

    if (!effectiveTokens) {
      // No tokens specified, check all tokens in token list
      await this.getAllTokenBalances(address, wallet, isHardware, balances);
    } else {
      // Get specific token balances
      await this.getSpecificTokenBalances(effectiveTokens, address, wallet, isHardware, balances);
    }

    return balances;
  }

  /**
   * Get balances for all tokens in the token list
   */
  private async getAllTokenBalances(
    address: string,
    wallet: Wallet | null,
    isHardware: boolean,
    balances: Record<string, number>,
  ): Promise<void> {
    logger.info(`Checking balances for all ${this.storedTokenList.length} tokens in the token list`);

    await Promise.all(
      this.storedTokenList.map(async (token) => {
        try {
          const contract = this.getContract(token.address, this.provider);
          const balance = isHardware
            ? await this.getERC20BalanceByAddress(contract, address, token.decimals, 2000, token.symbol)
            : await this.getERC20Balance(contract, wallet!, token.decimals, 2000, token.symbol);

          const balanceNum = parseFloat(tokenValueToString(balance));

          // Only add tokens with non-zero balances
          if (balanceNum > 0) {
            balances[token.symbol] = balanceNum;
            logger.debug(`Found non-zero balance for ${token.symbol}: ${balanceNum}`);
          }
        } catch (err) {
          logger.warn(`Error getting balance for ${token.symbol}: ${err.message}`);
        }
      }),
    );
  }

  /**
   * Get balances for specific tokens
   */
  private async getSpecificTokenBalances(
    tokens: string[],
    address: string,
    wallet: Wallet | null,
    isHardware: boolean,
    balances: Record<string, number>,
  ): Promise<void> {
    await Promise.all(
      tokens.map(async (symbolOrAddress) => {
        // Don't process native token again
        if (symbolOrAddress === this.nativeTokenSymbol) {
          return;
        }

        const token = this.getToken(symbolOrAddress);
        if (token) {
          try {
            const contract = this.getContract(token.address, this.provider);
            const balance = isHardware
              ? await this.getERC20BalanceByAddress(contract, address, token.decimals, 5000, token.symbol)
              : await this.getERC20Balance(contract, wallet!, token.decimals, 5000, token.symbol);

            balances[token.symbol] = parseFloat(tokenValueToString(balance));
          } catch (err) {
            logger.warn(`Error getting balance for ${token.symbol}: ${err.message}`);
            balances[token.symbol] = 0;
          }
        } else {
          logger.warn(`Token not recognized: ${symbolOrAddress}`);
          balances[symbolOrAddress] = 0;
        }
      }),
    );
  }
}
