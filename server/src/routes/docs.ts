import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { routeDocs } from '../http.ts';

function schemaOf(s: z.ZodType | undefined) {
  if (!s) return undefined;
  try {
    const json = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    delete json.$schema;
    return json;
  } catch {
    return { type: 'object' };
  }
}

export function openApiDocument(ctx: Ctx) {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();
  for (const r of routeDocs) {
    if (!r.url.startsWith('/api/') || r.url.startsWith('/api/auth/')) continue;
    tags.add(r.tag);
    const path = r.url.replace(/:([a-z_]+)/g, '{$1}');
    const params = [...r.url.matchAll(/:([a-z_]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'integer' } }));
    const query = schemaOf(r.query) as any;
    if (query?.properties) {
      for (const [name, schema] of Object.entries(query.properties)) params.push({ name, in: 'query', required: false, schema } as any);
    }
    const body = schemaOf(r.body);
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      tags: [r.tag],
      summary: r.summary,
      parameters: params.length ? params : undefined,
      requestBody: body ? { required: true, content: { 'application/json': { schema: body } } } : undefined,
      responses: { 200: { description: 'Success' }, 401: { description: 'Unauthenticated' }, 422: { description: 'Validation error' } },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'Kinetic API', version: '1.0.0', description: 'Authenticate with `Authorization: Bearer <token>`. Create tokens in Settings → API.' },
    servers: [{ url: ctx.config.publicUrl }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
  };
}

export function docsRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/openapi.json', { config: { public: true } }, () => openApiDocument(ctx));
  app.get('/api/reference', { config: { public: true } }, (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return `<!doctype html><html><head><title>Kinetic API Reference</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><script id="api-reference" data-url="/api/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.11"></script></body></html>`;
  });
}
