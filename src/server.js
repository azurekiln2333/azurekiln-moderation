import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const host = process.env.HOST ?? '127.0.0.1';
const app = await createApp();
const server = app.listen(port, host, () => console.info(JSON.stringify({ event: 'moderation.listening', host, port })));
server.on('error', () => {
  app.locals.close();
  console.error(JSON.stringify({ event: 'moderation.listen_failed' }));
  process.exitCode = 1;
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => app.locals.close());
  server.closeIdleConnections();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
