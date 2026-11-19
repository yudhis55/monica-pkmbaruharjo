import { u } from '../../../vendor/Du44SBtj.js';

/** HPKE client dari bundle resmi SSI. Shim vendor membaca process.env.ASIK_WEB_CTK. */
export function setClientKey(ctk: string) {
  process.env.ASIK_WEB_CTK = ctk;
  process.env.asik_web_ctk = ctk;
}

export async function encryptPayload(plaintext: unknown): Promise<string> {
  const out = await (u() as any).encrypt(plaintext);
  if (typeof out !== 'string') throw new Error('encrypt: expected _d string');
  return out;
}

export async function decryptResponse(body: any): Promise<any> {
  if (!body || typeof body._d !== 'string') return body;
  const out = await (u() as any).decrypt(body._d);
  if (typeof out === 'string') throw new Error('decrypt: server returned an error payload');
  return out;
}
