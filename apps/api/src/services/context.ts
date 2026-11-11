import type { Pool } from '@ubc/database';
import type { AppConfig } from '../config/env.js';
import type { Connectors } from './connectors.js';

export interface AppContext {
  pool: Pool;
  config: AppConfig;
  connectors: Connectors;
}

export class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details);
export const badRequest = (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details);
