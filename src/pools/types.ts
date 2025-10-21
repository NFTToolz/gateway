/**
 * Pool types and interfaces
 */

import { connectorsConfig } from '../config/routes/getConnectors';

export interface Pool {
  type: 'amm' | 'clmm';
  network: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  feePct: number;
  address: string;
}

export type PoolFileFormat = Pool[];

/**
 * Get list of supported connectors dynamically from connectorsConfig
 * This ensures the list is always up-to-date with available connectors
 */
export function getSupportedConnectors(): string[] {
  return connectorsConfig.map((c) => c.name);
}

/**
 * Check if a connector is supported by checking against the dynamic connectors config
 */
export function isSupportedConnector(connector: string): boolean {
  return connectorsConfig.some((c) => c.name === connector);
}

export interface PoolListRequest {
  connector: string;
  network?: string;
  type?: 'amm' | 'clmm';
  search?: string;
}

export interface PoolAddRequest {
  connector: string;
  type: 'amm' | 'clmm';
  network: string;
  address: string;
  baseSymbol?: string;
  quoteSymbol?: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  feePct?: number;
}
