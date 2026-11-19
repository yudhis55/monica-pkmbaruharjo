import { decryptResponse, encryptPayload, setClientKey } from './crypto.ts';
import {
  BASE_URL, DEFAULT_TIMEOUT_MS, REFERER, USER_AGENT, cookieHeader, readSetCookies, withRetry,
} from './http.ts';
import type { SsiPage, SsiUser } from './types.ts';

/** Hanya `token_eksternal` yang divalidasi server. `ctk`/`stk` dibuat ulang tiap run. */
export interface SsiAuth {
  tokenEksternal: string;
  /** Objek `user` wajib ikut di setiap payload; server memvalidasi faskes dari sini. */
  user?: SsiUser;
  /** Pasangan dari /api/crypto-key. Tidak perlu disimpan lintas run. */
  asikWebStk: string;
  asikWebCtk: string;
}

export class SsiSessionError extends Error {
  // Ditulis sebagai field biasa, bukan parameter property: Node hanya membuang tipe
  // (strip-only), jadi parameter property tidak bisa dijalankan tanpa tsx.
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'SsiSessionError';
    this.status = status;
    this.code = code;
  }
}

export async function fetchCryptoPair(timeoutMs = 30_000): Promise<{ stk: string; ctk: string }> {
  const res = await withRetry('crypto-key', async () => {
    const r = await fetch(`${BASE_URL}/api/crypto-key`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw Object.assign(new Error(`crypto-key HTTP ${r.status}`), { status: r.status });
    return readSetCookies(r);
  });
  if (!res.asik_web_stk || !res.asik_web_ctk) throw new Error('crypto-key: cookie stk/ctk tidak diterbitkan');
  // Nilai cookie ctk di-URL-encode server; HPKE butuh base64 mentah.
  return { stk: res.asik_web_stk, ctk: safeDecode(res.asik_web_ctk) };
}

function safeDecode(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}

export function buildAuth(tokenEksternal: string, pair: { stk: string; ctk: string }): SsiAuth {
  return { tokenEksternal, asikWebStk: pair.stk, asikWebCtk: pair.ctk };
}

export function makeUser(input: {
  userId?: string | number;
  fullname?: string;
  faskesCode?: string;
  partnerCode?: string | null;
  userType?: string | null;
}): SsiUser {
  const type = String(input.userType ?? '').toUpperCase();
  const partnerCategory = type === 'MITRA' ? 'mitra' : type === 'FKTP' ? 'klinik' : '';
  return {
    user_id: String(input.userId ?? ''),
    fullname: String(input.fullname ?? ''),
    faskes_code: String(input.faskesCode ?? ''),
    partner_code: String(input.partnerCode ?? ''),
    partner_category_code: partnerCategory,
  };
}

function authCookie(auth: SsiAuth): string {
  return cookieHeader({
    token_eksternal: auth.tokenEksternal,
    asik_web_stk: auth.asikWebStk,
    asik_web_ctk: auth.asikWebCtk,
  });
}

function classify(status: number, body: any): never {
  const code = body?.data?.meta?.system_message ?? body?.data?.code ?? body?.code;
  const msg = body?.message ?? body?.statusMessage ?? `HTTP ${status}`;
  throw new SsiSessionError(msg, status, code);
}

export interface SsiPostOptions {
  timeoutMs?: number;
  referer?: string;
  /** Dipanggil bila server meminta payload terenkripsi ulang (key kedaluwarsa). */
  onKeyExpired?: () => Promise<{ stk: string; ctk: string }>;
}

/**
 * POST ber-envelope `_d`. Selalu pasang ulang `ctk` dari request terakhir:
 * server menerbitkan keypair baru di setiap respons.
 */
export async function ssiPost<T = any>(
  path: string,
  payload: Record<string, unknown>,
  auth: SsiAuth,
  options: SsiPostOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function once(current: SsiAuth): Promise<T> {
    setClientKey(current.asikWebCtk);
    const plaintext = { user: current.user, ...payload };
    const encrypted = await encryptPayload(plaintext);
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: BASE_URL,
        referer: options.referer ?? REFERER,
        'user-agent': USER_AGENT,
        cookie: authCookie(current),
      },
      body: JSON.stringify({ _d: encrypted }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* biarkan teks mentah */ }

    if (!res.ok) {
      if (res.status === 401) {
        const code = body?.data?.meta?.system_message ?? body?.code;
        throw new SsiSessionError(body?.message ?? 'Sesi berakhir', 401, code);
      }
      if (res.status === 403 && (body?.data?.code === 'ENCRYPTED_PAYLOAD_REQUIRED' || body?.code === 'ENCRYPTED_PAYLOAD_REQUIRED')) {
        throw Object.assign(new Error('ENCRYPTED_PAYLOAD_REQUIRED'), { status: 403, encryptedPayloadRequired: true });
      }
      const err = Object.assign(new Error(`HTTP ${res.status}: ${body?.message ?? body?.statusMessage ?? ''}`), { status: res.status, body });
      throw err;
    }
    return (await decryptResponse(body)) as T;
  }

  return withRetry('ssi-post', async () => {
    try {
      return await once(auth);
    } catch (err: any) {
      if (err?.encryptedPayloadRequired && options.onKeyExpired) {
        const pair = await options.onKeyExpired();
        auth.asikWebStk = pair.stk;
        auth.asikWebCtk = pair.ctk;
        return await once(auth);
      }
      throw err;
    }
  });
}

export interface ListArgs {
  page: number;
  limit: number;
  faskesCode: string;
  screeningStartDate: string;
  screeningEndDate: string;
  patientNik?: string;
  patientName?: string;
  ticketNumber?: string;
  status?: string;
  partnerCode?: string;
}

/** `limit` maksimum yang diterima server: 5000 (terverifikasi). */
export const MAX_PAGE_LIMIT = 5000;

export async function listKunjunganUmum(args: ListArgs, auth: SsiAuth, options: SsiPostOptions = {}): Promise<SsiPage> {
  return ssiPost<SsiPage>(
    '/api/pkg/ssi/list-kunjungan-umum',
    {
      page: args.page,
      limit: Math.min(args.limit, MAX_PAGE_LIMIT),
      faskes_code: args.faskesCode,
      screening_start_date: args.screeningStartDate,
      screening_end_date: args.screeningEndDate,
      partner_code: args.partnerCode ?? '',
      ticket_number: args.ticketNumber ?? '',
      patient_nik: args.patientNik ?? '',
      patient_name: args.patientName ?? '',
      status: args.status ?? '',
    },
    auth,
    options,
  );
}

/**
 * `menu` satu-satunya endpoint ringan yang benar-benar memeriksa sesi:
 * 200 = sesi benar-benar aktif, 401/403 = ditolak.
 * Status filter `list-kunjungan-umum` tidak berfungsi (total sama untuk semua nilai) — jangan dipakai.
 */
export async function fetchSessionUser(auth: SsiAuth): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/user-management/menu`, {
    headers: { accept: 'application/json', cookie: authCookie(auth), 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new SsiSessionError('Sesi tidak valid', res.status);
  return res.json();
}
