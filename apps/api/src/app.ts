import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { Pool } from '@ubc/database';
import type { AppConfig } from './config/env.js';
import { createConnectors, type Connectors } from './services/connectors.js';
import { HttpError, type AppContext } from './services/context.js';
import { logError } from './services/audit.js';
import { registerCoreRoutes } from './routes/core.js';
import { registerCommerceRoutes } from './routes/commerce.js';

export async function buildApp(opts: { pool: Pool; config: AppConfig; connectors?: Connectors; logger?: boolean }): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const ctx: AppContext = { pool: opts.pool, config: opts.config, connectors: opts.connectors ?? createConnectors(opts.config, opts.pool) };
  const app = Fastify({
    logger: opts.logger === false ? false : { level: opts.config.env.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers["x-shopify-hmac-sha256"]'] },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);

  // Keep the raw body for webhook HMAC verification (must not be re-serialised).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(new HttpError(400, 'BAD_JSON', 'Malformed JSON body'), undefined);
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    else reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    return payload;
  });

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'VALIDATION', message: 'Invalid input', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    const e = err as Error & { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? 'BAD_REQUEST', message: e.message });
    req.log.error(err);
    await logError(ctx.pool, { companyId: req.session?.companyId ?? null, source: `api:${req.method} ${req.routeOptions.url}`, message: e.message }).catch(() => {});
    return reply.code(500).send({ error: 'INTERNAL', message: 'Unexpected error — it has been logged' });
  });

  registerCoreRoutes(app, ctx);
  registerCommerceRoutes(app, ctx);

  if (opts.config.env.ADMIN_DIR) {
    await app.register(fastifyStatic, { root: opts.config.env.ADMIN_DIR, prefix: '/', index: ['index.html'] });
  }
  return { app, ctx };
}
