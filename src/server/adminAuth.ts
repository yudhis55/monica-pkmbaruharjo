import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_COOKIE = 'monev_admin';
export const ADMIN_TTL_MS = 8 * 60 * 60_000;
const KEY_SALT = 'monev-admin:';

/**
 * Kunci tanda tangan cookie admin. Bila `secret` kosong, kunci diturunkan dari sandi —
 * konsekuensinya mengganti sandi otomatis membatalkan semua cookie lama.
 */
export function adminKey(password: string, secret = ''): Buffer {
  const explicit = secret.trim();
  if (explicit) return Buffer.from(explicit, 'utf8');
  return createHash('sha256').update(KEY_SALT + password).digest();
}

/** Token: `v1.<exp_ms>.<hmac_base64url>`. Stateless — tidak butuh penyimpanan server. */
export function signAdminToken(key: Buffer, exp: number): string {
  const mac = createHmac('sha256', key).update(`v1.${exp}`).digest('base64url');
  return `v1.${exp}.${mac}`;
}

export function verifyAdminToken(key: Buffer, token: string, now = Date.now()): boolean {
  const [v, expRaw, mac] = token.split('.');
  if (v !== 'v1' || !expRaw || !mac) return false;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp < now) return false;
  const want = createHmac('sha256', key).update(`v1.${exp}`).digest();
  let got: Buffer;
  try {
    got = Buffer.from(mac, 'base64url');
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}
