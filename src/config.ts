import { existsSync, readFileSync } from 'node:fs';

// Dimuat di sini, bukan di pemanggil: modul ini dievaluasi saat `import` (sebelum baris
// pertama cli.ts/script berjalan), jadi membaca .env di tempat lain selalu terlambat.
if (typeof process.loadEnvFile === 'function' && existsSync('.env')) {
  try { process.loadEnvFile('.env'); } catch { /* .env rusak: biarkan variabel proses apa adanya */ }
}

/**
 * Profil user SSI dari `localStorage.user_eksternal` (satu baris JSON).
 * Payload ke SSI memuat identitas ini, dan server SSI menolak bila `faskes_code`
 * tidak sama dengan organisasi pemilik token ("kode faskes tidak sesuai").
 * Satu variabel lebih sulit salah ketik daripada lima variabel terpisah.
 */
const userEksternal = (() => {
  const raw = process.env.SSI_USER_EKSTERNAL_JSON;
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
})();

export const CONFIG = {
  dbPath: process.env.MONEV_DB ?? 'data/monev.db',
  /** Postgres/Supabase. Bila diisi, menang atas SQLite `dbPath` (serverless). */
  databaseUrl: process.env.DATABASE_URL ?? '',
  port: Number(process.env.PORT ?? 4321),
  host: process.env.HOST ?? '127.0.0.1',
  faskesCode: String(userEksternal?.organitazion_ihs ?? userEksternal?.organitization_ihs ?? process.env.SSI_FASKES_CODE ?? '1000057936'),
  sweepStart: process.env.SSI_SWEEP_START ?? '2020-01-01',
  sweepEnd: process.env.SSI_SWEEP_END ?? '2030-12-31',
  // 2.000, bukan 5.000: pada 19 Nov 2026 limit 5.000 membuat SSI membalas 500 untuk rentang
  // lebar, sedangkan 2.000 dan 1.000 berhasil. runSync juga menurunkan otomatis bila perlu.
  pageSize: Number(process.env.SSI_PAGE_SIZE ?? 2000),
  /**
   * Batas halaman per request sync. Di serverless satu request dibatasi waktu, jadi
   * sapuan dipecah dan dilanjutkan lewat cursor. 0 = tanpa batas (proses panjang).
   */
  syncMaxPages: Number(process.env.MONEV_SYNC_MAX_PAGES ?? (process.env.VERCEL ? 2 : 0)),
  /**
   * Anggaran waktu per request sync. Diukur 19 Nov 2026: satu halaman 2.000 baris bisa
   * 216 detik saat SSI lambat, jadi batas 2 halaman saja bisa melewati 300 detik Vercel.
   * Hentikan setelah 200 detik; cursor melanjutkan halaman berikutnya.
   */
  syncMaxMs: Number(process.env.MONEV_SYNC_MAX_MS ?? (process.env.VERCEL ? 200_000 : 0)),
  /** Identitas user SSI. Wajib ikut di payload; server memvalidasi faskes dari sini. */
  userId: String(userEksternal?.id ?? process.env.SSI_USER_ID ?? '1221065'),
  fullname: String(userEksternal?.name ?? process.env.SSI_FULLNAME ?? 'Yudhistira Surya Ristyanto'),
  partnerCode: String(userEksternal?.partner_code ?? process.env.SSI_PARTNER_CODE ?? ''),
  userType: String(userEksternal?.user_type ?? process.env.SSI_USER_TYPE ?? ''),
  /** Profil mentah bila tersedia, untuk ditampilkan di diagnostik. */
  userEksternalProfile: userEksternal as { id?: string; name?: string; organitazion_ihs?: string; partner_code?: string; user_type?: string } | null,
  /** Target instance prod untuk mode lokal → prod. Kosong = mode mandiri. */
  pushTarget: process.env.MONEV_PUSH_TARGET ?? '',
  pushToken: process.env.MONEV_PUSH_TOKEN ?? '',
  ingestToken: process.env.MONEV_INGEST_TOKEN ?? '',
  /**
   * Sandi halaman admin. Kosong = admin tanpa sandi (hanya aman di localhost);
   * server menolak start tanpa sandi bila HOST bukan loopback.
   */
  adminPassword: process.env.MONEV_ADMIN_PASSWORD ?? '',
  /**
   * Kunci tanda tangan cookie admin (stateless). Kosong = diturunkan dari sandi admin,
   * jadi mengganti sandi otomatis membatalkan semua cookie lama. Isi eksplisit hanya
   * perlu bila sandi dikosongkan (mode localhost) tetapi cookie tetap harus bertanda.
   */
  adminSecret: process.env.MONEV_ADMIN_SECRET ?? '',
  /** Di belakang reverse proxy (nginx/Caddy/Vercel): ambil IP asli dari X-Forwarded-For. */
  trustProxy: process.env.MONEV_TRUST_PROXY === '1' || Boolean(process.env.VERCEL),
  /** Paksa atribut Secure pada cookie admin (otomatis bila permintaan HTTPS). */
  cookieSecure: process.env.MONEV_COOKIE_SECURE === '1',
};

export function readCookieJar(path: string): { tokenEksternal: string; refreshToken: string } | null {
  if (!existsSync(path)) return null;
  const jar = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  if (!jar.token_eksternal || !jar.refresh_token) return null;
  return { tokenEksternal: jar.token_eksternal, refreshToken: jar.refresh_token };
}

/** Impor sesi dari format .env scraper lama (SSI_COOKIE_HEADER). */
export function readScraperEnv(path = 'C:/PKM/tesscrapeckg/.env'): { tokenEksternal: string; refreshToken: string } | null {
  if (!existsSync(path)) return null;
  const before = { ...process.env };
  process.loadEnvFile(path);
  const cookie = process.env.SSI_COOKIE_HEADER ?? '';
  const jar = Object.fromEntries(cookie.split('; ').map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
  Object.assign(process.env, before);
  if (!jar.token_eksternal || !jar.refresh_token) return null;
  return { tokenEksternal: jar.token_eksternal, refreshToken: jar.refresh_token };
}
