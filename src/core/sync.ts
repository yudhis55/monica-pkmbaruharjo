import { MAX_PAGE_LIMIT, buildAuth, fetchCryptoPair, fetchSessionUser, listKunjunganUmum, makeUser, SsiSessionError } from './ssi/client.ts';
import type { SsiVisit } from './ssi/types.ts';
import type { Store } from './db/store.ts';
import { refreshSession } from './ssi/session.ts';
import { pushSnapshot } from './push.ts';

export interface SyncOptions {
  faskesCode: string;
  startDate: string;
  endDate: string;
  pageSize?: number;
  /** Jumlah halaman yang diambil bersamaan. Server menolak >3 secara konsisten. */
  concurrency?: number;
  onProgress?: (msg: { page: number; rows: number; totalPage: number }) => void;
  /** Mode lokal → prod. Kosongkan untuk mode mandiri. */
  push?: { target: string; token: string; onProgress?: (p: { sent: number; total: number }) => void };
  /**
   * Batas halaman per pemanggilan. `Infinity` = sapuan penuh dalam satu proses (default).
   * Serverless mengirim angka kecil (mis. 2) agar satu request tidak melewati batas waktu;
   * sisa halaman dilanjutkan lewat cursor `sweep.page` di panggilan berikutnya.
   */
  maxPages?: number;
  /** Percobaan ulang per request SSI (default 5; mode proxy 2). */
  attempts?: number;
  /** Batas waktu satu request SSI (default 120 dtk; mode proxy 45 dtk). */
  requestTimeoutMs?: number;
  /**
   * Anggaran waktu per pemanggilan. Halaman baru tidak dimulai bila sudah lewat batas,
   * sehingga satu request serverless (maks 300 detik) tidak dipotong di tengah halaman.
   * Halaman yang sudah selesai tetap tersimpan; cursor menunjuk halaman berikutnya.
   */
  maxMs?: number;
  userId?: string;
  fullname?: string;
  partnerCode?: string | null;
  userType?: string | null;
}

export interface SyncResult {
  ok: boolean;
  /** Sapuan tuntas; false berarti masih ada halaman tertunda (lanjutkan dengan panggilan baru). */
  done: boolean;
  fetched: number;
  pages: number;
  totalPage?: number;
  nextPage?: number;
  inserted: number;
  updated: number;
  unchanged: number;
  sessionExpired?: boolean;
  message?: string;
  /** Hasil kirim ke instance prod, hanya pada mode lokal → prod. */
  pushed?: { ok: boolean; sent: number; message?: string };
}

/**
 * Sapuan penuh: 13.373 baris = 3 halaman @5000, ±40 detik.
 * Tidak memakai filter tanggal sebagai definisi "kunjungan pada tanggal X" —
 * semantik filter tanggal di server tidak konsisten dengan field mana pun yang terlihat.
 */
export async function runSync(store: Store, opts: SyncOptions): Promise<SyncResult> {
  // `list-kunjungan-umum` butuh DUA hal: token sesi yang sah di cookie, dan objek `user`
  // di payload (server memvalidasi faskes dari situ). Diuji 19 Nov 2026: tanpa token
  // server membalas 401 "Sesi Anda sudah berakhir"; dengan token tetapi tanpa `user`
  // server membalas 400 "kode faskes tidak sesuai". `user` selalu diisi di bawah.
  const session = await store.getSession();

  const pageSize = Math.min(opts.pageSize ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const started = Date.now();

  // Mode proxy: percobaan lebih sedikit dan batas waktu lebih pendek, supaya satu proxy
  // buruk tidak menghabiskan seluruh anggaran waktu fungsi sebelum failover.
  const attempts = opts.attempts ?? 5;
  const reqTimeoutMs = opts.requestTimeoutMs;

  async function makeAuth() {
    const pair = await fetchCryptoPair(reqTimeoutMs ?? 30_000, attempts);
    return buildAuth(session?.tokenEksternal ?? '', pair);
  }

  const auth = await makeAuth();
  auth.user = makeUser({
    userId: opts.userId,
    fullname: opts.fullname,
    faskesCode: opts.faskesCode,
    partnerCode: opts.partnerCode,
    userType: opts.userType,
  });
  const common = {
    faskesCode: opts.faskesCode,
    screeningStartDate: opts.startDate,
    screeningEndDate: opts.endDate,
  };
  const hooks = { onKeyExpired: () => fetchCryptoPair(reqTimeoutMs ?? 30_000, attempts) };

  // Sweep bisa dipecah lintas request (serverless: satu request maksimum 300 detik,
  // sedangkan sapuan penuh bisa 6+ menit). Cursor disimpan di app_setting; rentang
  // berbeda berarti sweep baru dan cursor lama dibuang.
  const rangeKey = `${opts.startDate}|${opts.endDate}`;
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  const sameRange = (await store.getSetting('sweep.range')) === rangeKey;
  const savedPage = sameRange ? Number((await store.getSetting('sweep.page')) ?? 0) : 0;
  const savedLimit = sameRange ? Number((await store.getSetting('sweep.limit')) ?? 0) : 0;
  const savedTotal = sameRange ? Number((await store.getSetting('sweep.total')) ?? 0) : 0;

  // Ukuran halaman 5.000 terbukti bisa membuat server SSI membalas 500 untuk rentang lebar
  // (19 Nov 2026: 5.000 gagal setelah retry, 2.000 dan 1.000 berhasil). Turunkan otomatis
  // pada halaman pertama; batas halaman tetap konsisten karena semua halaman memakai `limit`
  // yang sama.
  const limitTry = [...new Set([pageSize, 2000, 1000])].filter((n) => n <= MAX_PAGE_LIMIT);
  let page = savedPage > 1 ? savedPage : 1;
  let totalPage = savedPage > 1 ? savedTotal : 0;
  // `limit` tersimpan hanya dipakai bila masih sama dengan yang diminta pemanggil. Mode
  // proxy menurunkan pageSize (500); memakai limit lama (2.000) membuat halaman lanjutan
  // terlalu besar dan melewati batas waktu fungsi. Offset tetap dijaga saat memetakan ulang.
  let usedLimit = savedPage > 1 && savedLimit > 0 && savedLimit === limitTry[0] ? savedLimit : limitTry[0];
  if (savedPage > 1 && savedLimit > 0 && savedLimit !== usedLimit) {
    const offset = (savedPage - 1) * savedLimit;
    page = Math.floor(offset / usedLimit) + 1;
  }
  // Kalau halaman lanjutan tetap 500 setelah percobaan ulang, limit diturunkan dan nomor
  // halaman dipetakan ulang menurut offset, bukan diulang dari halaman 1: daftar SSI adalah
  // irisan berurutan, jadi offset 3.000 dengan limit 500 = halaman 7. Tanpa pemetaan ini,
  // rentang 2026 butuh 21 menit karena halaman yang sudah tersimpan ditarik lagi.
  const MIN_LIMIT = 250;
  let shrinks = 0;

  /**
   * Halaman lanjutan kadang dibalas 500 "Gagal memuat data" (terukur 23 Nov 2026: halaman
   * 2 dari rentang 2026 gagal sekali, lalu lolos saat diulang). Percobaan ulang di sini,
   * bukan di pemanggil, supaya CLI dan HTTP memakai perilaku sama.
   */
  async function fetchPage(p: number, limit: number): Promise<any> {
    let lastErr: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await listKunjunganUmum({ ...common, page: p, limit }, auth, { ...hooks, attempts, timeoutMs: reqTimeoutMs });
      } catch (e: any) {
        lastErr = e;
        if (e?.status && e.status < 500) throw e; // 401/403/400: mengulang tidak menolong
        // 23 Nov 2026: data endpoint membalas 500/503 setelah ±2 menit menggantung. Jeda
        // pendek hanya menambah beban, jadi 5 dtk lalu 20 dtk.
        if (attempt === 1) await new Promise((r) => setTimeout(r, 5_000));
        if (attempt === 2) await new Promise((r) => setTimeout(r, 20_000));
      }
    }
    throw lastErr;
  }

  const all: SsiVisit[] = [];
  let fetched = 0, inserted = 0, updated = 0, unchanged = 0, pagesDone = 0;
  let done = false;

  const keep = async (batch: SsiVisit[], p: number) => {
    const res = await store.upsertVisits(batch);
    inserted += res.inserted; updated += res.updated; unchanged += res.unchanged;
    fetched += batch.length; pagesDone++;
    if (opts.push?.target && opts.push.token) all.push(...batch);
    opts.onProgress?.({ page: p, rows: fetched, totalPage });
  };

  const saveCursor = async (nextPage: number) => {
    await store.setSetting('sweep.range', rangeKey);
    await store.setSetting('sweep.page', String(nextPage));
    await store.setSetting('sweep.limit', String(usedLimit));
    await store.setSetting('sweep.total', String(totalPage));
  };

  try {
    while (true) {
      if (page === 1 && totalPage === 0) {
        // Halaman pertama sekaligus mendeteksi `limit` yang diterima server dan total halaman.
        let first: any;
        for (const limit of limitTry) {
          try {
            first = await listKunjunganUmum({ ...common, page: 1, limit }, auth, { ...hooks, attempts, timeoutMs: reqTimeoutMs });
            usedLimit = limit;
            break;
          } catch (e: any) {
            const retryable = !e?.status || e.status >= 500;
            if (!retryable || limit === limitTry[limitTry.length - 1]) {
              if (e instanceof SsiSessionError && (e.status === 401 || e.status === 403)) await store.setSessionError(e.message);
              return { ok: false, done: false, pages: 0, fetched, inserted, updated, unchanged, message: String(e?.message ?? e) };
            }
          }
        }
        if (!first) return { ok: false, done: false, pages: 0, fetched, inserted, updated, unchanged, message: 'tidak ada respons' };
        totalPage = Number(first?.data?.meta?.total_page ?? 1);
        await keep(first?.data?.list ?? [], 1);
      } else {
        let r: any;
        try {
          r = await fetchPage(page, usedLimit);
        } catch (e: any) {
          const shrunk = usedLimit / 2;
          if ((!e?.status || e.status >= 500) && shrunk >= MIN_LIMIT && shrinks < 2) {
            const offset = (page - 1) * usedLimit;
            shrinks++;
            usedLimit = shrunk;
            page = offset / usedLimit + 1;
            totalPage = 0;
            await saveCursor(page);
            continue;
          }
          throw e;
        }
        const tp = Number(r?.data?.meta?.total_page ?? 0);
        if (tp > 0) totalPage = tp;
        await keep(r?.data?.list ?? [], page);
      }

      page++;
      if (page > totalPage) {
        done = true;
        await saveCursor(0);
        await store.setSetting('sweep.page', '');
        break;
      }
      await saveCursor(page);
      if (pagesDone >= maxPages) break;
      if (opts.maxMs && Date.now() - started > opts.maxMs) break;
    }
  } catch (e: any) {
    if (e instanceof SsiSessionError && (e.status === 401 || e.status === 403)) {
      await store.setSessionError(e.message);
      return { ok: false, done: false, fetched, pages: pagesDone, inserted, updated, unchanged, sessionExpired: true, message: e.message };
    }
    const raw = String(e?.message ?? e);
    const spanDays = (Date.parse(opts.endDate) - Date.parse(opts.startDate)) / 86_400_000;
    const hint = !e?.status || e.status >= 500
      ? spanDays > 31
        ? ' — rentang lebar gagal; pecah per bulan: sync --start 2026-03-01 --end 2026-03-31'
        : ' — SSI sedang gagal untuk rentang ini; ulangi nanti'
      : '';
    return { ok: false, done: false, fetched, pages: pagesDone, inserted, updated, unchanged, message: raw + hint };
  }

  let pushed: { ok: boolean; sent: number; message?: string } | undefined;
  if (opts.push?.target && opts.push.token) {
    pushed = await pushSnapshot(opts.push.target, opts.push.token, all, { onProgress: opts.push.onProgress });
    if (!pushed.ok) {
      return {
        ok: false,
        done,
        fetched,
        pages: pagesDone,
        inserted,
        updated,
        unchanged,
        message: `tersimpan lokal, push ke ${opts.push.target} gagal: ${pushed.message ?? ''}`,
      };
    }
  }

  return {
    ok: true,
    done,
    pushed,
    fetched,
    pages: pagesDone,
    totalPage,
    nextPage: done ? undefined : page,
    inserted,
    updated,
    unchanged,
    message: `${((Date.now() - started) / 1000).toFixed(1)}s` + (done ? '' : ` (lanjut halaman ${page}/${totalPage})`),
  };
}

/**
 * Sesi SSI dianggap "segar" bila token_eksternal diperbarui < 6 jam lalu.
 * Refresh otomatis dijalankan sebelum sweep supaya sweep panjang tidak mati di tengah.
 * Dipanggil di dalam klaim sweep, jadi tidak bersamaan dengan refresh lain.
 */
export async function ensureFreshSession(store: Store, maxAgeMs = 6 * 60 * 60_000): Promise<void> {
  const s = await store.getSession();
  // Tanpa sesi, sapuan tetap jalan (lihat catatan di runSync). Perpanjangan dilewati.
  if (!s) return;
  if (Date.now() - Date.parse(s.updatedAt) <= maxAgeMs) return;
  const r = await store.withWriteLock(async () => {
    const fresh = await store.getSession();
    if (!fresh) return { ok: false as const, reason: 'expired' as const, message: 'Belum ada sesi.' };
    if (Date.now() - Date.parse(fresh.updatedAt) <= maxAgeMs) return { ok: true as const, session: fresh };
    const out = await refreshSession(fresh);
    if (out.ok) await store.saveSession(out.session);
    return out;
  });
  if (!r.ok) {
    // Refresh gagal bukan alasan membatalkan sapuan: endpoint baca masih menerima
    // token yang sudah dicabut (hanya keberadaan cookie yang diperiksa). Catat
    // supaya pengguna tahu perlu login, lalu biarkan sapuan mencoba.
    if (r.reason === 'expired' || r.reason === 'reused') await store.setSessionError(r.message);
  }
}

export type SessionProbe =
  | { state: 'none' }
  | { state: 'ok'; checkedAt: string }
  | { state: 'invalid'; message: string; checkedAt: string }
  | { state: 'unknown'; message: string; checkedAt: string };

/**
 * Cek sesi atas permintaan (bukan cron): dipanggil saat halaman dibuka.
 * Ringan — satu GET `/api/user-management/menu` ±0,4 detik, bukan sweep.
 * `record=false` (default) tidak menyentuh session_error: pemeriksaan tampilan
 * tidak boleh menandai sesi mati hanya karena /menu menolak.
 */
export async function probeSession(store: Store, record = false): Promise<SessionProbe> {
  const session = await store.getSession();
  if (!session) return { state: 'none' };
  const now = new Date().toISOString();
  try {
    const pair = await fetchCryptoPair();
    const auth = buildAuth(session.tokenEksternal, pair);
    await fetchSessionUser(auth);
    if (record) await store.clearSessionError();
    return { state: 'ok', checkedAt: now };
  } catch (e) {
    const message = String((e as any)?.message ?? e);
    if (e instanceof SsiSessionError && (e.status === 401 || e.status === 403)) {
      if (record) await store.setSessionError(message);
      return { state: 'invalid', message, checkedAt: now };
    }
    // Jaringan/5xx tidak boleh dianggap sesi mati: hanya dilaporkan sebagai "tidak diketahui".
    return { state: 'unknown', message, checkedAt: now };
  }
}
