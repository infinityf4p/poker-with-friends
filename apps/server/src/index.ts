import { createDatabase } from '@poker-with-friends/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PokerRepository } from './repository.js';
import { RoomManager } from './room/manager.js';
import { safeErrorLogContext } from './security/logging.js';

const config = loadConfig();
const { db, client } = createDatabase(config.DATABASE_URL);
const repository = new PokerRepository(db, config);
await repository.ensureConfiguredAdmin();
const rooms = new RoomManager(repository);
const { app, io } = await buildApp({ config, repository, rooms });

const maintenance = setInterval(
  () => {
    void Promise.all([repository.cleanupExpiredData(), rooms.archiveIdleRooms()]).catch((error) => {
      app.log.error({ failure: safeErrorLogContext(error) }, 'scheduled maintenance failed');
    });
  },
  60 * 60 * 1_000,
);
maintenance.unref();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'graceful shutdown started');
  clearInterval(maintenance);
  io.close();
  await app.close();
  await client.end();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(
  { host: config.HOST, port: config.PORT, build: config.APP_BUILD_SHA },
  'Poker with Friends server ready',
);
