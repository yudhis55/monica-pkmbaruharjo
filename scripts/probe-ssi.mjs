/**
 * Uji kelayakan: apakah API SSI bisa dipanggil dari jaringan/IP yang berbeda?
 *
 * Di laptop Puskesmas, jalankan skrip ini SEKALI di Wi-Fi kantor, lalu SEKALI lagi
 * lewat hotspot ponsel. Jawaban yang dicari: apakah `200` tetap keluar saat IP berubah.
 * Kalau ya, penarikan data bisa dijalankan dari server (mis. Vercel). Kalau tidak,
 * penarikan harus dari mesin dengan IP tempat login SSI dilakukan.
 *
 * Skrip ini hanya MEMBACA: satu cek sesi + satu halaman berisi 1 baris.
 * Tidak menulis ke database, tidak mengubah sesi.
 *
 *   npx tsx scripts/probe-ssi.mjs
 */
// Impor dinamis: config.ts membaca .env saat dievaluasi, jadi tidak boleh di-import
// sebelum environment siap (dan config.ts sendiri sudah memuat .env).
const { CONFIG } = await import('../src/config.ts');
const { Store } = await import('../src/core/db/store.ts');
const { fetchCryptoPair, buildAuth, makeUser, fetchSessionUser, listKunjunganUmum } = await import('../src/core/ssi/client.ts');

const fmt = (n) => new Intl.NumberFormat('id-ID').format(n);

// Rentang tanggal bisa dipersempit dari baris perintah:
//   npx tsx scripts/probe-ssi.mjs --start 2026-01-01 --end 2026-12-31
const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const store0 = await Store.open({ sqlitePath: CONFIG.dbPath, databaseUrl: CONFIG.databaseUrl });
const startDate = arg('start') ?? (await store0.getSetting('sweep.start')) ?? CONFIG.sweepStart;
const endDate = arg('end') ?? (await store0.getSetting('sweep.end')) ?? CONFIG.sweepEnd;
await store0.close();

async function ipKeluar() {
  // Alamat publik tidak dipakai SSI, tapi berguna untuk memastikan IP benar-benar berubah.
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return (await r.text()).trim();
    } catch {
      // lanjut ke penyedia berikutnya
    }
  }
  return '(tidak diketahui)';
}

const store = await Store.open({ sqlitePath: CONFIG.dbPath, databaseUrl: CONFIG.databaseUrl });
const session = await store.getSession();
if (!session) {
  console.log('Tidak ada sesi tersimpan. Login dulu lewat halaman admin.');
  process.exit(1);
}

const ip = await ipKeluar();
console.log('IP keluar :', ip);
console.log('Sesi      :', 'diperbarui', session.updatedAt);
console.log('Faskes    :', CONFIG.faskesCode,
  CONFIG.userEksternalProfile ? '(dari SSI_USER_EKSTERNAL_JSON)' : '(dari SSI_FASKES_CODE / bawaan)');
console.log('User      :', CONFIG.userId, '-', CONFIG.fullname);
console.log('Rentang   :', startDate, 's/d', endDate);
if (process.env.SSI_USER_EKSTERNAL_JSON && !CONFIG.userEksternalProfile) {
  console.log('PERINGATAN: SSI_USER_EKSTERNAL_JSON ada tetapi gagal dibaca sebagai JSON.');
}
console.log('');

let ok = 0;
let gagal = 0;

async function coba(label, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    ok++;
    console.log(`OK   ${label.padEnd(22)} ${String(ms).padStart(5)} ms${out ? '  ' + out : ''}`);
    return true;
  } catch (e) {
    gagal++;
    const status = e?.status ? ' HTTP ' + e.status : '';
    console.log(`GAGAL ${label.padEnd(21)}${status}  ${String(e?.message ?? e).slice(0, 160)}`);
    return false;
  }
}

await coba('crypto-key', async () => {
  const pair = await fetchCryptoPair();
  return pair.stk && pair.ctk ? 'stk/ctk diterima' : 'kosong';
});

const pair = await fetchCryptoPair().catch(() => null);
if (!pair) {
  console.log('\ncrypto-key gagal: jaringan atau Cloudflare memblokir. Hentikan di sini.');
  await store.close();
  process.exit(1);
}
const auth = buildAuth(session.tokenEksternal, pair);
// Wajib: `list-kunjungan-umum` memvalidasi faskes dari objek `user` di payload.
// Tanpa ini server membalas 400 "kode faskes tidak sesuai".
auth.user = makeUser({
  userId: CONFIG.userId,
  fullname: CONFIG.fullname,
  faskesCode: CONFIG.faskesCode,
  partnerCode: CONFIG.partnerCode,
  userType: CONFIG.userType,
});

const sesiOk = await coba('user-management/menu', async () => {
  const user = await fetchSessionUser(auth);
  const name = user?.data?.name ?? user?.name ?? '';
  return name ? 'user: ' + name : 'sesi sah';
});

// Tanpa sesi sah, panggilan data akan mengulang percobaan dan menggantung lama.
// Lebih berguna berhenti dengan instruksi jelas.
if (!sesiOk) {
  console.log('');
  console.log('Sesi SSI tidak berlaku. Login ulang lewat /admin (captcha), lalu jalankan skrip ini lagi.');
  await store.close();
  process.exit(1);
}

await coba('list-kunjungan-umum', async () => {
  const page = await listKunjunganUmum(
    { page: 1, limit: 1, faskesCode: CONFIG.faskesCode, screeningStartDate: startDate, screeningEndDate: endDate,
      userId: CONFIG.userId, fullname: CONFIG.fullname, partnerCode: CONFIG.partnerCode, userType: CONFIG.userType },
    auth,
    { timeoutMs: 25_000 },
  );
  const total = Number(page?.data?.meta?.total_data ?? page?.data?.meta?.total ?? 0);
  const baris = Array.isArray(page?.data?.list) ? page.data.list.length : 0;
  return `total ${fmt(total)} kunjungan, ${baris} baris di halaman ini`;
});

await store.close();
console.log('');
console.log(ok && !gagal
  ? 'Hasil: semua panggilan berhasil dari IP ini.'
  : 'Hasil: ada panggilan yang gagal dari IP ini.');
console.log('Bandingkan hasil ini dengan hasil di jaringan lain (hotspot ponsel).');
process.exit(gagal ? 2 : 0);
