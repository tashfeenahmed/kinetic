import { loadConfig } from './config.ts';
import { Db } from './db/db.ts';
import { setEncryptionKey } from './lib/crypto.ts';
import { RealMailGateway } from './mail/gateway.ts';
import { buildApp } from './app.ts';
import { Worker } from './engine/worker.ts';
import type { Ctx, Logger } from './context.ts';

const config = loadConfig();
setEncryptionKey(config.appKey);
const db = new Db(config.dbPath);

const app0 = { log: null as Logger | null };
const ctx: Ctx = {
  db,
  config,
  get log() { return app0.log!; },
  mail: new RealMailGateway(db),
  now: () => new Date(),
  fetch: globalThis.fetch,
};

const app = await buildApp(ctx, { logger: true });
app0.log = app.log as unknown as Logger;

const worker = new Worker(ctx);
if (config.workers) {
  worker.start();
  ctx.gtm!.engine.start();
}

await app.listen({ port: config.port, host: config.host });
app.log.info(`Kinetic running at ${config.publicUrl} (data: ${config.dataDir})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    worker.stop();
    ctx.gtm?.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
