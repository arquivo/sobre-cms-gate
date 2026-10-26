// Entry point: read the configuration, listen, and stop cleanly on SIGTERM (docker stop).
import { ConfigError, loadConfig } from './config.ts';
import { jsonLogger } from './log.ts';
import { createServer } from './server.ts';

const log = jsonLogger();

let loaded;
try {
  loaded = loadConfig(process.env);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  process.stderr.write(`cms-gate: ${e.message}\n`);
  process.exit(1);
}
const { config, warnings } = loaded;
for (const warning of warnings) log({ event: 'warning', message: warning });

const server = createServer(config, { log });
server.on('error', (e) => {
  log({ event: 'fatal', error: e.message });
  process.exit(1);
});
server.listen(config.listen.port, config.listen.host, () => {
  log({ event: 'listening', host: config.listen.host, port: config.listen.port, cmsOrigin: config.cmsOrigin });
});

const stop = (signal: string) => {
  log({ event: 'stopping', signal });
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
