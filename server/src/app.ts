import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from './context.ts';
import { HttpError } from './http.ts';
import { authenticate, authRoutes } from './routes/auth.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
import { leadRoutes } from './routes/leads.ts';
import { tagRoutes } from './routes/tags.ts';
import { libraryRoutes } from './routes/library.ts';
import { senderRoutes } from './routes/senders.ts';
import { campaignRoutes } from './routes/campaigns.ts';
import { inboxRoutes } from './routes/inbox.ts';
import { opsRoutes } from './routes/ops.ts';
import { trackingRoutes } from './routes/tracking.ts';
import { docsRoutes } from './routes/docs.ts';
import { domainRoutes } from './routes/domains.ts';
import { sequenceRoutes } from './routes/sequences.ts';
import { ZodError } from 'zod';
import { createGtm } from './gtm/index.ts';
import { gtmHookRoutes, gtmRoutes } from './gtm/routes.ts';
import { gtmLinkRoutes } from './gtm/linkRoutes.ts';
import { visitorRoutes } from './visitors/routes.ts';
import { sourcingRoutes } from './sourcing/routes.ts';
import { agentRoutes } from './agent/routes.ts';
import { mcpRoutes } from './agent/mcp.ts';
import { knowledgeRoutes } from './knowledge/routes.ts';
import { replyAiRoutes } from './routes/replyAi.ts';
import { leadFilterRoutes } from './routes/leadFilters.ts';
import { companionRoutes } from './companion/routes.ts';

const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: ctx.config.logLevel } : false,
    bodyLimit: 30 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie);
  // Unsubscribe forms and one-click POSTs are form-encoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.addContentTypeParser('multipart/form-data', { parseAs: 'string' }, (_req, body, done) => done(null, { raw: body }));
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    req.auth = authenticate(ctx, req);
    const isPublic = (req.routeOptions.config as any)?.public;
    if (!isPublic && !req.auth) throw new HttpError(401, { error: 'invalid_token', message: 'Unauthenticated.' });
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send(err.body);
    if (err instanceof ZodError) {
      const fields: Record<string, string[]> = {};
      for (const i of err.issues) (fields[i.path.join('.') || '_'] ??= []).push(i.message);
      return reply.code(422).send({ error: 'validation_error', message: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '), fields });
    }
    if (err.validation) return reply.code(422).send({ error: 'validation_error', message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'server_error', message: 'Something went wrong. Check the server log.' });
  });

  authRoutes(app, ctx);
  workspaceRoutes(app, ctx);
  leadRoutes(app, ctx);
  tagRoutes(app, ctx);
  libraryRoutes(app, ctx);
  senderRoutes(app, ctx);
  campaignRoutes(app, ctx);
  inboxRoutes(app, ctx);
  opsRoutes(app, ctx);
  trackingRoutes(app, ctx);
  ctx.gtm ??= createGtm(ctx);
  app.addHook('onClose', async () => ctx.gtm?.stop());
  gtmRoutes(app, ctx);
  gtmLinkRoutes(app, ctx);
  sourcingRoutes(app, ctx);
  domainRoutes(app, ctx);
  sequenceRoutes(app, ctx);
  gtmHookRoutes(app, ctx);
  knowledgeRoutes(app, ctx);
  agentRoutes(app, ctx);
  mcpRoutes(app, ctx);
  replyAiRoutes(app, ctx);
  leadFilterRoutes(app, ctx);
  companionRoutes(app, ctx);
  docsRoutes(app, ctx);
  visitorRoutes(app, ctx);

  app.get('/healthz', { config: { public: true } }, () => ({ ok: true }));

  if (existsSync(WEB_DIST)) {
    // wildcard routing serves files added after startup (e.g. after a rebuild).
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      wildcard: true,
      // Hashed build files never change; index.html must always be re-checked so new builds load.
      setHeaders: (res, path) => {
        res.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // A missing build file (e.g. an old tab asking for a chunk from a previous build) must 404,
      // not return index.html — the browser can't run HTML as JavaScript and the page would hang.
      const isAsset = req.url.startsWith('/assets/') || /\.(js|css|map|png|svg|woff2?)(\?|$)/.test(req.url);
      if (req.method === 'GET' && !isAsset && !req.url.startsWith('/api/') && !req.url.startsWith('/hooks/')) {
        reply.header('cache-control', 'no-cache');
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found', message: 'Route not found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'Route not found' }));
  }

  return app;
}
