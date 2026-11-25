import { isIndonesianIp } from './idRanges.ts';
import { fetchProxyPool, openProxySession, parseProxy, PROXY_SOURCES, type ProxySpec } from './proxyFetch.ts';
import { BASE_URL, REFERER, USER_AGENT } from './http.ts';
import { encryptPayload, setClientKey } from './crypto.ts';
import type { Store } from '../db/store.ts';
import { useDirectTransport, useProxyTransport } from './transport.ts';

/**
 * Mencari proxy Indonesia yang benar-benar bisa menarik data SSI.
 *
 * Dua tingkat uji, dan bedanya penting:
 * - `crypto-key` 200 → proxy hidup dan bisa keluar ke SSI.
 * - satu halaman data 200 → proxy cukup stabil untuk sync. Hanya ini yang disimpan
 *   sebagai `data_ok`, karena banyak proxy lolos uji pertama lalu mati di request kedua.
 */

export interface ProbeOutcome {
  addr: string;
  scheme: string;
  cryptoOk: boolean;
  dataOk: boolean;
  latencyMs: number | null;
  error: string | null;
}

const HOST = new URL(BASE_URL).host;

/**
 * Saringan murah: buka TCP ke proxy lalu kirim CONNECT. Tidak menyentuh TLS maupun SSI.
 * Gunanya menyisihkan proxy mati (80-90% dari daftar publik) sebelum uji penuh yang mahal.
 */
async function tcpReachable(spec: ProxySpec, timeoutMs: number): Promise<boolean> {
  const net = await import('node:net');
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const sock = net.connect({ host: spec.host, port: spec.port });
  const done = (v: boolean) => { try { sock.destroy(); } catch { /* sudah tutup */ } resolve(v); };
  const timer = setTimeout(() => done(false), timeoutMs);
  sock.once('connect', () => {
    // Proxy HTTP/HTTPS wajib menjawab CONNECT; SOCKS cukup bisa dihubungi.
    if (spec.scheme === 'http' || spec.scheme === 'https') {
      sock.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`);
      sock.once('data', (d) => {
        clearTimeout(timer);
        const code = Number((/^HTTP\/1\.[01] (\d{3})/.exec(d.toString('latin1')) ?? [])[1]);
        done(code === 200);
      });
    } else {
      clearTimeout(timer);
      done(true);
    }
  });
  sock.once('error', () => { clearTimeout(timer); done(false); });
  return promise;
}

/** Satu proxy: crypto-key lalu satu halaman kecil dengan token karangan. */
async function probe(spec: ProxySpec, timeoutMs: number, faskesCode: string): Promise<ProbeOutcome> {
  const started = Date.now();
  const base = { addr: `${spec.host}:${spec.port}`, scheme: spec.scheme };
  let session: Awaited<ReturnType<typeof openProxySession>> | null = null;
  try {
    session = await openProxySession(spec, HOST, 443, timeoutMs);
    const ck = await session.request({
      method: 'GET', path: '/api/crypto-key',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      timeoutMs,
    });
    if (ck.status !== 200) return { ...base, cryptoOk: false, dataOk: false, latencyMs: ck.ms, error: `crypto-key ${ck.status}` };

    const jar: Record<string, string> = {};
    for (const line of ck.setCookies) {
      const first = line.split(';')[0];
      const i = first.indexOf('=');
      if (i > 0) jar[first.slice(0, i).trim()] = first.slice(i + 1).trim();
    }
    if (!jar.asik_web_stk || !jar.asik_web_ctk) {
      return { ...base, cryptoOk: true, dataOk: false, latencyMs: ck.ms, error: 'cookie stk/ctk tidak ada' };
    }

    setClientKey(decodeURIComponent(jar.asik_web_ctk));
    const enc = await encryptPayload({
      // faskes_code wajib: SSI membalas 400 bila kosong, dan itu akan salah dibaca
      // sebagai "proxy tidak bisa" padahal proxy-nya sehat.
      user: { user_id: '', fullname: '', faskes_code: faskesCode, partner_code: '', partner_category_code: '' },
      page: 1, limit: 3, faskes_code: faskesCode,
      screening_start_date: '2026-11-01', screening_end_date: '2026-11-30',
      partner_code: '', ticket_number: '', patient_nik: '', patient_name: '', status: '',
    });
    const res = await session.request({
      method: 'POST', path: '/api/pkg/ssi/list-kunjungan-umum',
      headers: {
        accept: 'application/json', 'content-type': 'application/json',
        origin: BASE_URL, referer: REFERER, 'user-agent': USER_AGENT,
        // Token karangan: cukup membuktikan jalur baca, tanpa kredensial asli.
        cookie: `token_eksternal=${'x'.repeat(128)}; asik_web_stk=${jar.asik_web_stk}; asik_web_ctk=${jar.asik_web_ctk}`,
      },
      body: JSON.stringify({ _d: enc }),
      timeoutMs: Math.max(timeoutMs, 25_000),
    });
    const dataOk = res.status === 200 && res.body.includes('"_d"');
    return {
      ...base, cryptoOk: true, dataOk,
      latencyMs: Date.now() - started,
      error: dataOk ? null : `data ${res.status}`,
    };
  } catch (e) {
    return { ...base, cryptoOk: false, dataOk: false, latencyMs: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    session?.close();
  }
}

/** Jalankan `fn` untuk tiap item dengan batas konkurensi. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface RefreshResult {
  fetched: number;
  indonesian: number;
  /** Lolos saringan TCP, sebelum uji penuh. */
  reachable: number;
  probed: number;
  cryptoOk: number;
  dataOk: number;
  ms: number;
}

/**
 * Segarkan pool: unduh semua sumber, saring IP Indonesia, uji `limit` kandidat, simpan.
 * Kandidat yang sudah pernah berhasil ditaruh di depan supaya tidak diuji ulang sia-sia.
 */
export async function refreshProxyPool(
  store: Store,
  opts: { limit?: number; concurrency?: number; timeoutMs?: number; faskesCode: string; tcpTimeoutMs?: number },
): Promise<RefreshResult> {
  const started = Date.now();
  // `limit` membatasi uji PENUH (mahal), bukan saringan TCP: daftar publik mayoritas mati,
  // jadi sampel kecil hampir pasti tidak menghasilkan apa pun. Terukur 25 Nov 2026:
  // 40 kandidat acak → 0 hidup; seluruh 6.500 kandidat → puluhan hidup.
  const limit = opts.limit ?? 120;
  const concurrency = opts.concurrency ?? 40;
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const tcpTimeoutMs = opts.tcpTimeoutMs ?? 2_500;

  const pool = await fetchProxyPool(PROXY_SOURCES, { timeoutMs: 30_000 });
  const idOnly = pool.filter((p) => isIndonesianIp(p.host));

  // Yang sudah terbukti dipakai lebih dulu; sisanya diacak supaya tidak selalu alamat awal
  // (daftar publik cenderung mengurutkan berdasarkan tanggal, dan yang di atas sudah mati).
  const known = new Set((await store.workingProxies(200)).map((r) => r.addr));
  const knownSpecs: ProxySpec[] = [];
  const fresh: ProxySpec[] = [];
  for (const p of idOnly) {
    if (known.has(`${p.host}:${p.port}`)) knownSpecs.push(p); else fresh.push(p);
  }
  for (let i = fresh.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
  }
  // Saringan TCP atas seluruh pool Indonesia (bukan sampel), yang sudah dikenal lebih dulu.
  const candidates = [...knownSpecs, ...fresh];

  // Tahap 1 — TCP murah. Ini yang membuat ribuan kandidat layak dicoba dalam satu request.
  const reachable = (await mapLimit(candidates, 250, async (spec) => (
    (await tcpReachable(spec, tcpTimeoutMs)) ? spec : null
  ))).filter((x): x is ProxySpec => x !== null);

  // Tahap 2 — uji penuh hanya untuk yang lolos TCP, dibatasi `limit`.
  const outcomes = await mapLimit(reachable.slice(0, limit), concurrency, (spec) => probe(spec, timeoutMs, opts.faskesCode));
  for (const o of outcomes) {
    await store.saveProxyResult({
      addr: o.addr, scheme: o.scheme, cryptoOk: o.cryptoOk, dataOk: o.dataOk,
      latencyMs: o.latencyMs, error: o.error,
    });
  }

  return {
    fetched: pool.length,
    indonesian: idOnly.length,
    reachable: reachable.length,
    probed: outcomes.length,
    cryptoOk: outcomes.filter((o) => o.cryptoOk).length,
    dataOk: outcomes.filter((o) => o.dataOk).length,
    ms: Date.now() - started,
  };
}

/**
 * Pilih proxy terbaik yang masih hidup. `workingProxies` hanya berisi yang pernah lolos
 * uji data; bila kosong, pool dianggap belum siap dan pemanggil harus menjalankan refresh.
 */
export async function pickWorkingProxy(store: Store, faskesCode: string, attempts = 4): Promise<{ raw: string } | null> {
  const list = await store.workingProxies(attempts);
  for (const row of list) {
    // Verifikasi cepat: proxy bisa saja mati sejak uji terakhir.
    const spec = parseProxy(`${row.scheme}://${row.addr}`);
    if (!spec) continue;
    const r = await probe(spec, 8_000, faskesCode);
    await store.saveProxyResult({
      addr: r.addr, scheme: r.scheme, cryptoOk: r.cryptoOk, dataOk: r.dataOk,
      latencyMs: r.latencyMs, error: r.error,
    });
    if (r.dataOk) return { raw: `${r.scheme}://${r.addr}` };
  }
  return null;
}

/** Kegagalan yang wajar terjadi pada proxy gratis, bukan pada SSI. */
function looksLikeProxyFailure(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|other side closed|koneksi proxy ditutup|proxy|tunnel|timeout|fetch failed/i.test(msg);
}

export interface ProxyRunResult<T> {
  value: T;
  proxy: string;
  attempts: number;
}

/**
 * Jalankan `fn` lewat proxy Indonesia, berganti proxy saat gagal.
 *
 * Kenapa berganti, bukan memilih sekali: proxy gratis mati dalam hitungan menit (terukur
 * 25 Nov 2026 — satu proxy yang lolos uji data sudah tidak bisa dipasang 30 detik
 * kemudian). Karena setiap halaman di-upsert dan cursor sweep disimpan di DB, menjalankan
 * ulang dari halaman yang sama aman; yang tidak boleh adalah mengganti proxy di tengah
 * satu koneksi, dan itu tidak terjadi di sini.
 */
export async function runWithProxy<T>(
  store: Store,
  faskesCode: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; refreshIfEmpty?: boolean } = {},
): Promise<ProxyRunResult<T>> {
  const attempts = opts.attempts ?? 5;
  const tried = new Set<string>();
  let lastError: unknown = new Error('tidak ada proxy yang bisa dipakai');

  for (let i = 0; i < attempts; i++) {
    const working = await store.workingProxies(30);
    const candidates = await store.proxyCandidates(30);
    const queue = [...working.map((r) => `${r.scheme}://${r.addr}`), ...candidates.map((r) => `${r.scheme}://${r.addr}`)]
      .filter((raw) => !tried.has(raw));

    // Pool kosong atau semua sudah dicoba: segarkan sekali, lalu ambil lagi.
    if (!queue.length) {
      if (i === 0 && opts.refreshIfEmpty !== false) {
        await refreshProxyPool(store, { limit: 250, faskesCode, concurrency: 50, timeoutMs: 6_000 });
        continue;
      }
      break;
    }

    const raw = queue[0];
    tried.add(raw);
    const transport = await useProxyTransport(raw);
    if (!transport) {
      await store.saveProxyResult({ addr: raw.replace(/^[a-z0-9]+:\/\//, ''), scheme: raw.split('://')[0], cryptoOk: false, dataOk: false, error: 'gagal dipasang' });
      continue;
    }
    try {
      const value = await fn();
      return { value, proxy: raw, attempts: i + 1 };
    } catch (e) {
      lastError = e;
      await store.saveProxyResult({ addr: raw.replace(/^[a-z0-9]+:\/\//, ''), scheme: raw.split('://')[0], cryptoOk: true, dataOk: false, error: String((e as Error)?.message ?? e).slice(0, 120) });
      if (!looksLikeProxyFailure(e)) throw e;
    } finally {
      useDirectTransport();
    }
  }
  throw lastError;
}
