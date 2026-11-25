import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateByPetugas, bucketOf, type ReportRow } from '../src/core/report.ts';
import { indexVisits, matchVerdict, yearOf, type Verdict, type VerdictStatus } from '../src/core/verdict.ts';

function row(petugas: string, status: VerdictStatus, ada: boolean, failReason: string | null = null, year: number | null = 2026): ReportRow {
  const verdict: Verdict = {
    status, ada, lengkap: status === 'LENGKAP', matchedRegIds: ada ? ['x'] : [], method: 'nik',
  };
  return {
    assignmentId: 0, rowNo: 0, petugas, nik: null, name: null, nameSource: null, birthDate: null, targetDate: null, year, verdict, layanan: null,
    failReason, failReasonLabel: failReason, bucket: bucketOf({ verdict, failReason }),
    note: null, flaggedBy: failReason ? 'excel' : null, flaggedAt: null,
  };
}

test('pasien tercatat tapi belum diinput tetap dihitung "ada"', () => {
  const { totals } = aggregateByPetugas([row('Rina', 'BELUM_DIINPUT', true), row('Rina', 'LENGKAP', true)]);
  assert.equal(totals.assigned, 2);
  assert.equal(totals.ada, 2);
  assert.equal(totals.belum, 1);
  assert.equal(totals.lengkap, 1);
});

test('pasien yang tidak ditemukan tidak dihitung "ada"', () => {
  const { totals } = aggregateByPetugas([row('Rina', 'BELUM_DIINPUT', false)]);
  assert.equal(totals.ada, 0);
  assert.equal(totals.belum, 1);
});

test('ringkasan per petugas dipisah dan persentase memakai pembagi yang benar', () => {
  const { perPetugas } = aggregateByPetugas([
    row('Rina', 'LENGKAP', true), row('Rina', 'BELUM_DIINPUT', true),
    row('Budi', 'LENGKAP', true),
  ]);
  const rina = perPetugas.find((p) => p.petugas === 'Rina')!;
  const budi = perPetugas.find((p) => p.petugas === 'Budi')!;
  assert.equal(rina.assigned, 2);
  assert.equal(rina.pctLengkap, 50);
  assert.equal(budi.pctLengkap, 100);
});

test('diinput hanya LENGKAP; sisanya terbagi gagal dan perlu ditagih', () => {
  const { totals } = aggregateByPetugas([
    row('Rina', 'LENGKAP', true),
    row('Rina', 'DIINPUT_SEBAGIAN', true),
    row('Rina', 'BELUM_DIINPUT', false),
    row('Rina', 'AMBIGU', false),
  ]);
  assert.equal(totals.assigned, 4);
  assert.equal(totals.diinput, 1);
  assert.equal(totals.gagalDitandai, 0);
  assert.equal(totals.perluTindakan, 3);
});

test('tidak diinput dipecah: sudah ditandai gagal vs masih perlu ditagih', () => {
  const { totals } = aggregateByPetugas([
    row('Rina', 'BELUM_DIINPUT', false, 'faskes_lain'),
    row('Rina', 'BELUM_DIINPUT', false),
    row('Rina', 'AMBIGU', false),
  ]);
  // Gagal yang sudah ditandai bukan "belum" lagi, jadi tidak ikut perlu ditagih.
  assert.equal(totals.gagalDitandai, 1);
  assert.equal(totals.perluTindakan, 2);
  assert.equal(totals.perluTindakan + totals.gagalDitandai, 3);
});

test('tanda gagal pada baris yang ternyata LENGKAP tidak menambah perlu tindakan', () => {
  const { totals } = aggregateByPetugas([row('Rina', 'LENGKAP', true, 'faskes_lain')]);
  assert.equal(totals.diinput, 1);
  assert.equal(totals.gagalDitandai, 0);
  assert.equal(totals.perluTindakan, 0);
});

test('empat kategori: diinput, faskes lain, data tidak valid, sisanya belum diinput', () => {
  const { totals } = aggregateByPetugas([
    row('Rina', 'LENGKAP', true),
    row('Rina', 'BELUM_DIINPUT', false, 'faskes_lain'),
    row('Rina', 'AMBIGU', false),
    row('Rina', 'BELUM_DIINPUT', false, 'nik_tidak_valid'),
    row('Rina', 'BELUM_DIINPUT', false),
  ]);
  // "Data tidak valid" tidak pernah disimpulkan dari baris tanpa tanda (AMBIGU/tanpa NIK).
  assert.equal(totals.diinput, 1);
  assert.equal(totals.faskesLain, 1);
  assert.equal(totals.tidakValid, 1);
  // sisa kategori = belum diinput yang belum punya sebab
  assert.equal(totals.perluTindakan, 2);
});

test('baris tanpa tanda tidak pernah dihitung sebagai data tidak valid', () => {
  const { totals } = aggregateByPetugas([
    row('Rina', 'AMBIGU', false),
    row('Rina', 'BELUM_DIINPUT', false),
  ]);
  assert.equal(totals.tidakValid, 0);
  assert.equal(totals.faskesLain, 0);
  assert.equal(totals.perluTindakan, 2);
});

test('tanda NIK tidak terdaftar masuk kategori data tidak valid', () => {
  const { totals } = aggregateByPetugas([row('Rina', 'BELUM_DIINPUT', false, 'nik_tidak_terdaftar')]);
  assert.equal(totals.tidakValid, 1);
});

const visit = (nik: string, registerDate: string | null) => ({
  reg_id: 'r-' + nik + '-' + (registerDate ?? 'x'),
  self_check_status: 'Lengkap',
  screening_count_all: 9,
  screening_count_done: 9,
  patient: { nik, fullname: 'PASIEN', birth_date: '1990-01-01' },
  register_date: registerDate,
});

const nikOf = { nik: '3503130000000001', name: 'PASIEN', birthDate: '1990-01-01' };

test('kunjungan tahun lain tidak dihitung sebagai input penugasan tahun ini', () => {
  const idx = indexVisits([visit(nikOf.nik, '2025-03-01')], new Set([2026]));
  const v = matchVerdict(nikOf, idx.byNik, idx.byNameDob);
  assert.equal(v.status, 'BELUM_DIINPUT');
  assert.equal(v.ada, false);
});

test('kunjungan tahun penugasan tetap dihitung', () => {
  const idx = indexVisits([visit(nikOf.nik, '2026-03-01')], new Set([2026]));
  const v = matchVerdict(nikOf, idx.byNik, idx.byNameDob);
  assert.equal(v.status, 'LENGKAP');
  assert.equal(v.ada, true);
});

test('kunjungan tanpa register_date tidak dijadikan bukti', () => {
  const idx = indexVisits([visit(nikOf.nik, null)], new Set([2026]));
  const v = matchVerdict(nikOf, idx.byNik, idx.byNameDob);
  assert.equal(v.status, 'BELUM_DIINPUT');
});

test('tanpa saringan tahun, semua kunjungan dipakai (perilaku lama)', () => {
  const idx = indexVisits([visit(nikOf.nik, '2025-03-01')]);
  assert.equal(matchVerdict(nikOf, idx.byNik, idx.byNameDob).status, 'LENGKAP');
});

test('yearOf membaca tahun dari ISO dan angka', () => {
  assert.equal(yearOf('2026-09-01T00:00:00Z'), 2026);
  assert.equal(yearOf('2025-01-01'), 2025);
  assert.equal(yearOf(null), null);
  assert.equal(yearOf(''), null);
});

test('PDF capaian muat satu halaman dan tidak memotong tabel', async () => {
  const { buildCapaianPdf, PDF_MAX_ROWS } = await import('../src/core/pdfCapaian.ts');
  const rows = Array.from({ length: 12 }, (_, i) => ({
    petugas: 'PETUGAS ' + (i + 1), assigned: 76, diinput: 63, gagal: 5, belum: 8, pct: 89.5,
  }));
  const pdf = buildCapaianPdf({
    title: 'Capaian Entry Petugas — Monev CKG',
    meta: [['Batch', 'September (2026)'], ['Faskes', 'Puskesmas Baruharjo'], ['Periode data', 'Tahun penugasan 2026']],
    rows,
    total: { petugas: 'TOTAL', assigned: 912, diinput: 756, gagal: 60, belum: 96, pct: 89.5 },
  });
  const text = pdf.toString('latin1');
  assert.equal(text.slice(0, 8), '%PDF-1.4');
  assert.match(text, /\/Count 1\b/, 'harus tepat satu halaman');
  // Tanda kurung di-escape di dalam string PDF, jadi dicari dalam bentuk ter-escape.
  assert.ok(text.includes('Septiembre') === false);
  assert.ok(text.includes('September \\(2026\\)'), 'identitas batch ikut tercetak (tanda kurung di-escape)');
  assert.match(text, /PETUGAS 12/);
  assert.match(text, /89,5%/);
  assert.match(text, /Gagal/);
  // Footer aturan sudah dihapus: tidak boleh ada teks catatan di dasar halaman.
  assert.ok(!text.includes('Diinput = pasien'), 'footer tidak boleh tercetak lagi');
  assert.ok(text.includes('startxref'));

  // Lebih dari satu halaman: daftar dipecah, bukan melempar galat. Batch nyata berisi
  // 63 petugas, jadi perilaku lama membuat tombol "Unduh PDF" selalu gagal.
  const many = buildCapaianPdf({
    title: 't', meta: [],
    rows: Array.from({ length: PDF_MAX_ROWS + 10 }, (_, i) => ({ petugas: 'X' + (i + 1), assigned: 1, diinput: 1, gagal: 0, belum: 0, pct: 100 })),
    total: { petugas: 'TOTAL', assigned: 1, diinput: 1, gagal: 0, belum: 0, pct: 100 },
  });
  const manyText = many.toString('latin1');
  assert.match(manyText, /\/Count 2\b/, 'kelebihan baris pindah ke halaman kedua');
  assert.equal(manyText.slice(0, 8), '%PDF-1.4');
  assert.ok(manyText.includes('TOTAL'), 'baris total tetap dicetak');
  assert.match(manyText, /Halaman 1 dari 2/);
  assert.match(manyText, /Halaman 2 dari 2/);

  // Tepat penuh: total tidak boleh hilang, jadi dibuat halaman tambahan.
  const exact = buildCapaianPdf({
    title: 't', meta: [],
    rows: Array.from({ length: PDF_MAX_ROWS }, () => ({ petugas: 'X', assigned: 1, diinput: 1, gagal: 0, belum: 0, pct: 100 })),
    total: { petugas: 'TOTAL', assigned: 1, diinput: 1, gagal: 0, belum: 0, pct: 100 },
  }).toString('latin1');
  assert.match(exact, /\/Count 2\b/);
  assert.ok(exact.includes('TOTAL'), 'total tidak boleh hilang saat halaman tepat penuh');
});

test('capaian menghitung gagal ditandai sebagai selesai', () => {
  const { totals } = aggregateByPetugas([
    row('Rina', 'LENGKAP', true),
    row('Rina', 'BELUM_DIINPUT', false, 'nik_tidak_valid'),
    row('Rina', 'BELUM_DIINPUT', false, 'faskes_lain'),
    row('Rina', 'BELUM_DIINPUT', false),
  ]);
  assert.equal(totals.diinput, 1);
  assert.equal(totals.gagalDitandai, 2);
  assert.equal(totals.perluTindakan, 1);
  assert.equal(totals.selesai, 3);
  assert.equal(totals.pctCapaian, 75);
  assert.equal(totals.pctLengkap, 25, 'capaian input apa adanya tetap tersedia');
});

test('data hilang dihitung gagal input, bukan belum diinput', () => {
  const { totals } = aggregateByPetugas([
    row('Rina', 'BELUM_DIINPUT', false, 'data_hilang'),
    row('Rina', 'BELUM_DIINPUT', false),
  ]);
  assert.equal(totals.dataHilang, 1);
  assert.equal(totals.gagalDitandai, 1);
  assert.equal(totals.perluTindakan, 1);
  assert.equal(totals.pctCapaian, 50);
});

test('sebab lama di luar tiga kategori tidak jatuh ke "belum"', () => {
  // "pasien menolak" dari file Excel lama tetap dihitung gagal, jadi harus punya keranjang sendiri.
  const legacy = row('Rina', 'BELUM_DIINPUT', false, 'pasien_tidak_ditemukan');
  assert.equal(bucketOf(legacy), 'LAINNYA');
  const { totals } = aggregateByPetugas([legacy, row('Rina', 'BELUM_DIINPUT', false)]);
  assert.equal(totals.gagalDitandai, 1);
  assert.equal(totals.perluTindakan, 1);
  assert.equal(totals.diinput + totals.gagalDitandai + totals.perluTindakan, totals.assigned);
});
