import { describe, expect, it } from 'vitest';
import { resolvePoolConfig } from './pool.js';

describe('resolvePoolConfig (local Postgres & Supabase TLS)', () => {
  it('keeps plain TCP for localhost URLs', () => {
    const cfg = resolvePoolConfig('postgresql://ubc:ubc@127.0.0.1:5432/ubc_commerce_hub');
    expect(cfg.ssl).toBeUndefined();
    expect(cfg.connectionString).toBe('postgresql://ubc:ubc@127.0.0.1:5432/ubc_commerce_hub');
  });

  it('configures TLS and strips sslmode override for Supabase pooler URLs', () => {
    const cfg = resolvePoolConfig('postgresql://postgres.abcdefgh:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require');
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
    expect(cfg.connectionString).not.toContain('sslmode=');
    expect(cfg.connectionString).toContain('aws-0-us-east-1.pooler.supabase.com:5432/postgres');
  });
});
