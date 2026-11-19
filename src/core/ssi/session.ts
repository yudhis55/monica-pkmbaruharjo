import { BASE_URL, REFERER, USER_AGENT, readSetCookies, withRetry } from './http.ts';

export interface SessionState {
  tokenEksternal: string;
  refreshToken: string;
  updatedAt: string;
}

/**
 * refresh-token bersifat SINGLE-USE dan merotasi kredensial.
 * Memakai refresh_token lama = server mencabut seluruh sesi.
 * Karena itu SEMUA pemanggilan harus melewati satu antrean (serial).
 */
let queue: Promise<unknown> = Promise.resolve();

export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

export type RefreshResult =
  | { ok: true; session: SessionState }
  | { ok: false; reason: 'expired' | 'reused' | 'network' | 'unknown'; message: string };

const LOCK = 'session-refresh';

export async function refreshSession(current: SessionState): Promise<RefreshResult> {
  const res = await withRetry('refresh-token', async () => {
    const r = await fetch(`${BASE_URL}/api/user-management/refresh-token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        origin: BASE_URL,
        referer: REFERER,
        'user-agent': USER_AGENT,
        cookie: `token_eksternal=${current.tokenEksternal}; refresh_token=${current.refreshToken}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* teks mentah */ }
    return { status: r.status, body, cookies: readSetCookies(r) };
  }).catch((err: any) => ({ status: 0, body: { message: String(err?.message ?? err) }, cookies: {} as Record<string, string>, network: true }));

  if (res.status === 200) {
    const token = res.cookies.token_eksternal;
    const refresh = res.cookies.refresh_token;
    if (!token || !refresh) {
      return { ok: false, reason: 'unknown', message: 'refresh 200 tetapi cookie tidak diperbarui' };
    }
    return { ok: true, session: { tokenEksternal: token, refreshToken: refresh, updatedAt: new Date().toISOString() } };
  }

  const code: string = res.body?.data?.meta?.system_message ?? res.body?.code ?? '';
  if (res.status === 0) return { ok: false, reason: 'network', message: res.body?.message ?? 'jaringan gagal' };
  if (code === 'ERROR_TOKEN_MANUALLY_REVOKED' || /tidak lagi aktif/i.test(res.body?.message ?? '')) {
    return { ok: false, reason: 'reused', message: 'Sesi dicabut (refresh token dipakai ulang). Perlu login ulang.' };
  }
  if (res.status === 401) return { ok: false, reason: 'expired', message: 'Refresh token kedaluwarsa. Perlu login ulang.' };
  return { ok: false, reason: 'unknown', message: `refresh gagal: HTTP ${res.status}` };
}

export { LOCK };
