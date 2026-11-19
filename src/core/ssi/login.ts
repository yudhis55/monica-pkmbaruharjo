import { BASE_URL, USER_AGENT } from './http.ts';
import type { SessionState } from './session.ts';
import type { Store } from '../db/store.ts';

/** Captcha SSI: gambar JPEG 150x50 yang harus dibaca manusia. Tidak ada endpoint teks. */
export interface Captcha {
  id: string;
  /** data:image/jpeg;base64,... — langsung dipasang di <img>. */
  image: string;
  expiresAt: string;
}

export type LoginResult =
  | { ok: true; session: SessionState }
  | { ok: false; reason: 'captcha' | 'credentials' | 'locked' | 'unknown'; message: string };

/**
 * Cookie `asik_web_stk`/`asik_web_ctk` diterbitkan bersama captcha dan harus ikut
 * pada POST login — captcha terikat ke pasangan itu, bukan hanya ke id.
 *
 * State disimpan di DB (bukan Map di memori): di serverless, permintaan gambar captcha
 * dan POST login bisa dilayani instance berbeda, dan keduanya harus melihat state sama.
 */
const TTL_MS = 10 * 60_000;

function jarFrom(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

export async function fetchCaptcha(store: Store): Promise<Captcha> {
  if (!store) throw new Error('fetchCaptcha butuh store untuk menyimpan state captcha');
  const res = await fetch(`${BASE_URL}/auth/login`, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`captcha: HTTP ${res.status}`);
  const html = await res.text();
  const data = html.match(/id="__NUXT_DATA__">([\s\S]*?)<\/script>/);
  if (!data) throw new Error('captcha: payload Nuxt tidak ditemukan');
  const arr = JSON.parse(data[1]) as unknown[];
  const node = arr.find((x) => x && typeof x === 'object' && 'captcha_id' in (x as object)) as any;
  const id = String(arr[node.captcha_id]);
  const image = String(arr[node.captcha_image]);
  const jar = jarFrom(res);
  const expiresAt = Date.now() + TTL_MS;
  await store.saveCaptcha(id, jar, TTL_MS);
  return { id, image, expiresAt: new Date(expiresAt).toISOString() };
}

export async function submitLogin(store: Store, input: {
  captchaId: string;
  code: string;
  email: string;
  password: string;
}): Promise<LoginResult> {
  // Sekali pakai: baris dihapus saat diambil, apa pun hasil login-nya.
  const state = await store.takeCaptcha(input.captchaId);
  if (!state || Date.parse(state.expiresAt) < Date.now()) {
    return { ok: false, reason: 'captcha', message: 'Captcha kedaluwarsa. Muat ulang captcha.' };
  }

  const res = await fetch(`${BASE_URL}/api/user-management/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      cookie: state.jar,
      origin: BASE_URL,
      referer: `${BASE_URL}/auth/login`,
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      captcha_id: input.captchaId,
      captcha_code: input.code,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* bukan JSON */ }
  const message = String(body?.data?.meta?.message ?? body?.message ?? '');

  if (res.ok) {
    const jar = Object.fromEntries(
      res.headers.getSetCookie().map((c) => {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        return [pair.slice(0, i), pair.slice(i + 1)];
      }),
    );
    const tokenEksternal = jar.token_eksternal ?? body?.data?.token_eksternal;
    const refreshToken = jar.refresh_token ?? body?.data?.refresh_token;
    if (!tokenEksternal || !refreshToken) {
      return { ok: false, reason: 'unknown', message: 'Login 200 tetapi token tidak diterbitkan.' };
    }
    return { ok: true, session: { tokenEksternal, refreshToken, updatedAt: new Date().toISOString() } };
  }

  if (/captcha/i.test(message)) {
    return { ok: false, reason: 'captcha', message };
  }
  if (/kata sandi|password|email/i.test(message)) {
    return { ok: false, reason: 'credentials', message };
  }
  // SSI membalas 501 saat percobaan gagal beruntun; tunggu 2 menit.
  if (res.status === 429 || res.status === 501) {
    return { ok: false, reason: 'locked', message: message || 'Terlalu banyak percobaan login.' };
  }
  return { ok: false, reason: 'unknown', message: message || `login gagal: HTTP ${res.status}` };
}
