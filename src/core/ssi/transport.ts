import { BASE_URL, USER_AGENT } from './http.ts';
import { openProxySession, parseProxy, type ProxySession, type ProxySpec } from './proxyFetch.ts';

/**
 * Titik masuk tunggal untuk semua permintaan HTTP ke SSI.
 *
 * Kenapa ada: di Vercel, SSI membalas 403 untuk `crypto-key` maupun `/auth/login` karena
 * IP pusat data ditolak (terukur 20-25 Nov 2026, iad1 maupun sin1). Satu-satunya jalur
 * keluar adalah proxy Indonesia. Supaya `ssiPost` tidak perlu tahu soal proxy, transport
 * dipilih sekali di sini: langsung (default) atau lewat satu tunnel proxy.
 */
export interface TransportResponse {
  status: number;
  body: string;
  /** Semua baris Set-Cookie; pemanggil yang menggabungkan. */
  setCookies: string[];
  ms: number;
}

export interface Transport {
  /** Nama untuk log/diagnostik. */
  readonly label: string;
  request(path: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; timeoutMs?: number }): Promise<TransportResponse>;
  close(): void;
}

/** Transport default: `fetch` global, koneksi baru per permintaan. */
class DirectTransport implements Transport {
  readonly label = 'langsung';
  async request(path: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; timeoutMs?: number }): Promise<TransportResponse> {
    const started = Date.now();
    const res = await fetch(`${BASE_URL}${path}`, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
    });
    // Header `set-cookie` berulang; tipe DOM hanya menyatakan string gabungan.
    const raw = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = raw.getSetCookie?.() ?? [];
    return { status: res.status, body: await res.text(), setCookies, ms: Date.now() - started };
  }
  close() { /* tidak ada yang perlu ditutup */ }
}

/** Transport lewat satu tunnel proxy; dipakai ulang untuk seluruh sapuan. */
class ProxyTransport implements Transport {
  readonly label: string;
  private session: ProxySession | null = null;
  private readonly spec: ProxySpec;
  private readonly host: string;

  constructor(spec: ProxySpec) {
    this.spec = spec;
    this.host = new URL(BASE_URL).host;
    this.label = `proxy ${spec.raw}`;
  }

  private async ensure() {
    if (!this.session) this.session = await openProxySession(this.spec, this.host, 443, 15_000);
    return this.session;
  }

  async request(path: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; timeoutMs?: number }): Promise<TransportResponse> {
    const s = await this.ensure();
    // Batas per-request lebih pendek dari default 120 dtk: proxy gratis yang menggantung
    // harus cepat dinyatakan gagal supaya failover sempat terjadi di dalam batas 300 dtk
    // fungsi serverless. Halaman data normal selesai < 3 dtk lewat proxy yang sehat.
    const timeoutMs = Math.min(init.timeoutMs ?? 45_000, 45_000);
    const r = await s.request({ ...init, path, timeoutMs });
    return { status: r.status, body: r.body, setCookies: r.setCookies, ms: r.ms };
  }

  close() {
    this.session?.close();
    this.session = null;
  }
}

let current: Transport = new DirectTransport();

export function getTransport(): Transport {
  return current;
}

/** Pasang transport untuk seluruh modul SSI. Selalu tutup yang lama. */
export function setTransport(next: Transport): void {
  if (current !== next) current.close();
  current = next;
}

export function useDirectTransport(): void {
  setTransport(new DirectTransport());
}

/** Coba satu proxy; null bila handshake gagal. */
export async function useProxyTransport(raw: string): Promise<Transport | null> {
  const spec = parseProxy(raw);
  if (!spec) return null;
  const t = new ProxyTransport(spec);
  try {
    // Uji ringan: satu crypto-key. Gagal di sini berarti proxy tidak layak sama sekali.
    const r = await t.request('/api/crypto-key', {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      timeoutMs: 15_000,
    });
    if (r.status !== 200) { t.close(); return null; }
    setTransport(t);
    return t;
  } catch {
    t.close();
    return null;
  }
}
