import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import type { Ctx } from './context.ts';

export class HttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? body.error));
    this.status = status;
    this.body = body;
  }
}

export const notFound = (what = 'resource') => new HttpError(404, { error: 'not_found', message: `${what} not found` });
export const badRequest = (message: string) => new HttpError(400, { error: 'bad_request', message });
export const forbidden = (message = 'forbidden') => new HttpError(403, { error: 'forbidden', message });

/** Validates input with zod; errors use the `{error:'validation_error', fields:{...}}` shape. */
export function parse<S extends ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  const fields: Record<string, string[]> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_';
    (fields[key] ??= []).push(issue.message);
  }
  throw new HttpError(422, { error: 'validation_error', message: 'The given data was invalid.', fields });
}

// ---- request auth context -------------------------------------------------

export interface Auth {
  userId: number;
  workspaceId: number;
  role: 'admin' | 'editor' | 'viewer';
  via: 'session' | 'token';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
  }
}

export function auth(req: FastifyRequest): Auth {
  if (!req.auth) throw new HttpError(401, { error: 'invalid_token', message: 'Unauthenticated.' });
  return req.auth;
}

/** Throws unless the caller can modify data (viewers are read-only). */
export function canWrite(req: FastifyRequest): Auth {
  const a = auth(req);
  if (a.role === 'viewer') throw forbidden('Viewers cannot change data.');
  return a;
}

export function requireAdmin(req: FastifyRequest): Auth {
  const a = auth(req);
  if (a.role !== 'admin') throw forbidden('Only workspace admins can do this.');
  return a;
}

// ---- pagination ----------------------------------------------------------

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(500).default(25),
});

export function paginate<T>(ctx: Ctx, sql: string, params: any[], q: { page: number; per_page: number }, map?: (row: any) => T) {
  const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM (${sql})`, params)!.n;
  const rows = ctx.db.all(`${sql} LIMIT ? OFFSET ?`, [...params, q.per_page, (q.page - 1) * q.per_page]);
  return {
    data: map ? rows.map(map) : rows,
    meta: { current_page: q.page, per_page: q.per_page, total, last_page: Math.max(1, Math.ceil(total / q.per_page)) },
  };
}

// ---- route registry (feeds the OpenAPI document) ---------------------------

export interface RouteDoc {
  method: string;
  url: string;
  tag: string;
  summary: string;
  body?: ZodType;
  query?: ZodType;
  public?: boolean;
}

export const routeDocs: RouteDoc[] = [];

type Handler = (req: FastifyRequest<any>, reply: FastifyReply) => Promise<unknown> | unknown;

/** Registers a route and records it for the API reference. */
export function defineRoutes(app: FastifyInstance, tag: string) {
  const add = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE') =>
    (url: string, summary: string, handler: Handler, doc: { body?: ZodType; query?: ZodType; public?: boolean } = {}) => {
      if (!routeDocs.some((r) => r.method === method && r.url === url)) routeDocs.push({ method, url, tag, summary, ...doc });
      app.route({ method, url, config: { public: !!doc.public }, handler });
    };
  return { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };
}

export const idParam = (req: FastifyRequest, name = 'id') => {
  const v = Number((req.params as any)[name]);
  if (!Number.isInteger(v) || v <= 0) throw notFound();
  return v;
};

export const bool = z.preprocess((v) => (v === 'true' || v === '1' || v === 1 ? true : v === 'false' || v === '0' || v === 0 ? false : v), z.boolean());
export const idList = z.array(z.coerce.number().int().positive()).min(1);
