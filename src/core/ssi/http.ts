export const BASE_URL = 'https://sehatindonesiaku.kemkes.go.id';
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const REFERER = `${BASE_URL}/ckg-pelayanan`;
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Parse semua Set-Cookie menjadi objek sederhana (tanpa atribut). */
export function readSetCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const list = (res.headers as any).getSetCookie?.() as string[] | undefined;
  for (const raw of list ?? []) {
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) out[first.slice(0, eq)] = first.slice(eq + 1);
  }
  return out;
}

export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Retry dengan backoff eksponensial. `fetch failed`/ECONNRESET/503 terbukti intermiten. */
export async function withRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseDelayMs ?? 1_000;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err: any) {
      lastErr = err;
      const status = err?.status as number | undefined;
      const netErr = err?.name === 'TimeoutError' || /fetch failed|ECONNRESET|socket hang up|other side closed/i.test(String(err?.message));
      const retryable = netErr || isRetryableStatus(status);
      if (!retryable || i === attempts) throw err;
      opts.onRetry?.(err, i);
      await sleep(base * 2 ** (i - 1) + Math.floor(Math.random() * 400));
    }
  }
  throw lastErr;
}
