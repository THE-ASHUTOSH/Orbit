/**
 * Entry point: build the app, start Chromium, listen on the LAN, and shut all of
 * it down cleanly on a signal.
 *
 * startServer() is exported so integration tests can boot the real thing -
 * real Chromium, real WebSocket, real arbiter - on an ephemeral port.
 */
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import { config, configWarnings } from './config.js';
import { log } from './log.js';
import { closeDatabase, openDatabase } from './db.js';
import { Runtime } from './runtime.js';
import { Hub } from './ws/hub.js';
import { buildApp } from './api/routes.js';
import { MdnsResponder, lanAddress } from './mdns.js';

function resolveWebRoot(): string | null {
  const candidates = [
    config.webRoot,
    '/app/web',
    path.resolve(import.meta.dirname, '../../web/dist'),
    path.resolve(process.cwd(), 'apps/web/dist'),
  ].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(path.join(c, 'index.html'))) ?? null;
}

export interface RunningServer {
  server: http.Server;
  hub: Hub;
  rt: Runtime;
  port: number;
  url: string;
  shutdown: (reason?: string) => Promise<void>;
}

export async function startServer(opts: { waitForBrowser?: boolean } = {}): Promise<RunningServer> {
  for (const warning of configWarnings()) log.warn(warning);

  openDatabase();

  const rt = new Runtime();
  const app = buildApp(rt, () => hub);
  const hub = new Hub(rt);
  rt.bindHub(hub);

  // Static frontend, same origin as the API and the WebSocket. Anything not
  // matched by /api or /ws falls through to index.html for client-side routing.
  const webRoot = resolveWebRoot();
  if (webRoot) {
    app.use(express.static(webRoot, { index: false, maxAge: '1h', etag: true }));
    app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
      // The entry document names the hashed asset files, so caching it means a
      // client can keep loading yesterday's bundle after a deploy. Assets are
      // content-hashed and stay cacheable; only this must always be fresh.
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(webRoot, 'index.html'));
    });
    log.info('serving frontend', { webRoot });
  } else {
    log.warn('frontend build not found - API only (run: npm run build)');
  }

  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  hub.attachTo(server);

  // Chromium comes up in parallel with the listener so the UI can render a
  // "browser starting" state instead of refusing connections.
  const browserReady = rt.start().catch((err) => log.error('browser failed to start', { err }));

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const ip = lanAddress();
  log.info('listening', { url: `http://${ip ?? 'localhost'}:${port}`, host: config.host, port });

  let mdns: MdnsResponder | null = null;
  if (config.mdnsEnabled && ip) {
    mdns = new MdnsResponder(config.mdnsHostname, ip);
    mdns.start();
    log.info('lan name', { url: `http://${config.mdnsHostname}.local:${port}` });
  }

  if (opts.waitForBrowser !== false) await browserReady;

  let closing = false;
  const shutdown = async (reason = 'shutdown') => {
    if (closing) return;
    closing = true;
    log.info('shutdown started', { signal: reason });
    // Order matters: stop new connections, tell clients, stop streams, then let
    // Chromium flush its profile before the process goes away.
    server.close();
    mdns?.stop();
    await hub.shutdown(`server received ${reason}`);
    await rt.shutdown();
    closeDatabase();
    log.info('shutdown complete');
  };

  return { server, hub, rt, port, url: `http://127.0.0.1:${port}`, shutdown };
}

async function main(): Promise<void> {
  const running = await startServer();
  const stop = async (signal: string) => {
    await running.shutdown(signal);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { err: reason as Error }));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err });
    void stop('uncaughtException');
  });
}

// Only self-start when executed directly, so importing this module in a test
// does not boot a second server.
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().catch((err) => {
    log.error('fatal startup error', { err });
    process.exit(1);
  });
}
