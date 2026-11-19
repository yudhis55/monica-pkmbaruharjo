import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/server/app.ts';

/**
 * Entry point serverless (Vercel / Netlify Functions).
 *
 * Satu instance Fastify dipakai ulang per warm lambda (`buildApp` di-cache modul).
 * Tidak ada `listen`: Vercel menyerahkan req/res Node mentah, dan Fastify menangani
 * keduanya lewat `emit('request')` setelah `ready()`.
 */
let appPromise: Promise<any> | null = null;

function getApp() {
  appPromise ??= buildApp();
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  await app.ready();
  app.server.emit('request', req, res);
}
