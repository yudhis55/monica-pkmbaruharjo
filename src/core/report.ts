import type { Store } from './db/store.ts';
import { MATCH_RULES, indexVisits, matchVerdict, resolveMatchRule, yearOf, RULE_VERSION, type MatchRule, type Verdict } from './verdict.ts';
import { normalizeNik } from './normalize.ts';
import { failReasonLabel } from './excel.ts';

/**
 * Hasil akhir satu baris seperti yang dibaca orang. Dipakai bersama oleh tampilan,
 * filter, dan ekspor supaya "Diinput" tidak pernah berarti beda di dua tempat.
 */
export type Bucket = 'DIINPUT' | 'TIDAK_VALID' | 'FASKES_LAIN' | 'DATA_HILANG' | 'LAINNYA' | 'BELUM';

export function bucketOf(row: { verdict: { status: string }; failReason: string | null }): Bucket {
  if (row.verdict.status === 'LENGKAP') return 'DIINPUT';
  if (row.failReason === 'nik_tidak_valid' || row.failReason === 'nik_tidak_terdaftar') return 'TIDAK_VALID';
  if (row.failReason === 'faskes_lain') return 'FASKES_LAIN';
  if (row.failReason === 'data_hilang') return 'DATA_HILANG';
  // Sebab lama dari file (mis. "pasien menolak") tetap dihitung gagal, jadi harus punya
  // keranjang sendiri — bukan jatuh ke "belum", yang akan bertentangan dengan angka capaian.
  if (row.failReason) return 'LAINNYA';
  return 'BELUM';
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  DIINPUT: 'Diinput',
  TIDAK_VALID: 'Data tidak valid',
  FASKES_LAIN: 'Faskes lain',
  DATA_HILANG: 'Data hilang',
  LAINNYA: 'Gagal (lainnya)',
  BELUM: 'Belum diinput',
};

export interface ReportRow {
  assignmentId: number;
  rowNo: number | null;
  petugas: string;
  nik: string | null;
  name: string | null;
  /** `excel` = dari file penugasan, `ssi` = diambil dari kunjungan SSI, null = tidak diketahui. */
  nameSource: 'excel' | 'ssi' | null;
  birthDate: string | null;
  targetDate: string | null;
  /** Tahun penugasan (kolom Excel / tanggal target). */
  year: number | null;
  verdict: Verdict;
  /**
   * Layanan terkirim / total layanan pada kunjungan yang cocok.
   * `null` = rincian belum diambil. `LENGKAP` hanya berarti formulir skrining
   * langsung tuntas; angka ini menunjukkan apakah layanannya ikut terkirim.
   */
  layanan: { submitted: number; total: number } | null;
  /** Sebab gagal dari tanda pegawai/supervisor; null = belum ditandai. */
  failReason: string | null;
  failReasonLabel: string | null;
  /** Hasil akhir baris; satu-satunya sumber untuk filter dan ekspor. */
  bucket: Bucket;
  note: string | null;
  flaggedBy: string | null;
  flaggedAt: string | null;
}

export interface PetugasSummary {
  petugas: string;
  assigned: number;
  ada: number;
  lengkap: number;
  sebagian: number;
  belum: number;
  ambigu: number;
  pctLengkap: number;
  /** Hasil utama monev: pasien yang sudah punya screening lengkap. */
  diinput: number;
  /** Sudah ditandai gagal (tidak valid / faskes lain / data hilang): dianggap beres. */
  gagalDitandai: number;
  /** Masih harus ditagih ke pegawai: belum diinput dan belum ditandai apa pun. */
  perluTindakan: number;
  /** diinput + gagalDitandai. */
  selesai: number;
  /** selesai / assigned dalam persen satu desimal — angka capaian yang dipakai laporan. */
  pctCapaian: number;
  /** Petugas menyatakan laporannya sudah disetor (dasar aksi "tandai sudah setor"). */
  submitted: boolean;
  /** Waktu setor (ISO) bila `submitted`. */
  submittedAt: string | null;
  /** Setoran menandai sisa pasien sebagai "Data Hilang", jadi sisanya ikut dihitung selesai. */
  includesGagal: boolean;
  /** Rincian gagal per jenis, untuk kartu ringkasan. */
  tidakValid: number;
  faskesLain: number;
  dataHilang: number;
}

export interface Report {
  ruleVersion: string;
  /** Syarat yang dipakai untuk menganggap pasien sudah diinput. */
  matchRule: MatchRule;
  /** Label syarat untuk dicetak di PDF/Excel. */
  dasarHitungan: string;
  /** Tahun yang tersedia pada batch aktif, urut menurun. */
  years: number[];
  /** Tahun yang dipakai untuk laporan ini; `null` = semua tahun. */
  year: number | null;
  /** Identitas batch aktif yang dipakai. */
  batchName: string | null;
  batch: { id: number; name: string; periodStart: string | null; periodEnd: string | null; status: string; imports: number; lastImportAt: string | null } | null;
  generatedAt: string;
  batchId: number | null;
  totals: PetugasSummary;
  perPetugas: PetugasSummary[];
  rows: ReportRow[];
  lastSyncAt: string | null;
  visitCount: number;
  /** Tahun kunjungan yang dipakai sebagai bukti; `null` = semua tahun. */
  matchYears: number[] | null;
  /** Jumlah kunjungan yang lolos saringan tahun. */
  visitsMatched: number;
  /** Setoran laporan yang sudah dicatat per petugas pada batch ini. */
  submissions: Array<{ petugas: string; at: string; by: string | null; hitungGagal: boolean }>;
}

/**
 * Setoran yang sudah tidak menutup data. Impor ulang boleh menambah pasien baru, sehingga
 * "sudah setor" bisa bertentangan dengan angka (masih ada yang belum diinput). Setoran
 * seperti itu dicabut, bukan dibiarkan: pasien baru tidak boleh otomatis dianggap hilang.
 */
export function staleSubmissions(perPetugas: PetugasSummary[]): string[] {
  return perPetugas.filter((p) => p.submitted && p.perluTindakan > 0).map((p) => p.petugas);
}

export function aggregateByPetugas(rows: ReportRow[]): { totals: PetugasSummary; perPetugas: PetugasSummary[] } {
  const empty = (petugas: string): PetugasSummary => ({
    petugas, assigned: 0, ada: 0, lengkap: 0, sebagian: 0, belum: 0, ambigu: 0, pctLengkap: 0,
    diinput: 0, gagalDitandai: 0, perluTindakan: 0, selesai: 0, pctCapaian: 0,
    submitted: false, submittedAt: null, includesGagal: false,
    tidakValid: 0, faskesLain: 0, dataHilang: 0,
  });
  // Satu aturan untuk semuanya: LENGKAP = diinput. Selain itu tidak diinput,
  // lalu dipecah menurut apakah sebabnya sudah ditandai.
  const isDiinput = (r: { verdict: { status: string } }) => r.verdict.status === 'LENGKAP';
  const groups = new Map<string, PetugasSummary>();
  const totals = empty('TOTAL');
  for (const r of rows) {
    const g = groups.get(r.petugas) ?? empty(r.petugas);
    for (const target of [g, totals]) {
      target.assigned++;
      // "Ada di SSI" = rekam medisnya ditemukan, terlepas sudah diinput atau belum.
      // Pasien yang tercatat tapi masih "Belum Dilakukan" tetap harus terhitung ada.
      if (r.verdict.ada) target.ada++;
      if (r.verdict.status === 'LENGKAP') target.lengkap++;
      else if (r.verdict.status === 'DIINPUT_SEBAGIAN') target.sebagian++;
      if (r.verdict.status === 'BELUM_DIINPUT') target.belum++;
      else if (r.verdict.status !== 'LENGKAP' && r.verdict.status !== 'DIINPUT_SEBAGIAN') target.ambigu++;
      // "Gagal" bukan lagi bagian dari "belum": pasien yang sudah ditandai tidak valid atau
      // faskes lain dianggap beres, jadi otomatis menambah capaian.
      if (isDiinput(r)) {
        target.diinput++;
      } else if (r.failReason) {
        target.gagalDitandai++;
        if (r.failReason === 'faskes_lain') target.faskesLain++;
        else if (r.failReason === 'data_hilang') target.dataHilang++;
        else if (r.failReason === 'nik_tidak_valid' || r.failReason === 'nik_tidak_terdaftar') target.tidakValid++;
      } else {
        target.perluTindakan++;
      }
    }
    groups.set(r.petugas, g);
  }
  for (const g of [...groups.values(), totals]) {
    g.pctLengkap = g.assigned ? Math.round((g.lengkap / g.assigned) * 1000) / 10 : 0;
    g.selesai = g.diinput + g.gagalDitandai;
    g.pctCapaian = g.assigned ? Math.round((g.selesai / g.assigned) * 1000) / 10 : 0;
  }
  return { totals, perPetugas: [...groups.values()] };
}

export async function buildReport(store: Store, batchId?: number, year?: number | null, ruleInput?: string | null): Promise<Report> {
  const batchRow = batchId ? await store.getBatch(batchId) : await store.resolveBatch(null);
  const batch = batchRow ? { id: batchRow.id } : null;
  // Aturan "dianggap diinput" diatur admin per batch; argumen eksplisit (mis. laporan historis) menang.
  const rule = resolveMatchRule(ruleInput ?? batchRow?.match_rule);

  // Tahun penugasan per baris: kolom Tahun dari Excel, atau turunan tanggal target.
  // Tanpa tahun, satu-satunya jawaban jujur adalah mencocokkan semua tahun (perilaku lama).
  const assignments = batch ? await store.assignmentsOf(batch.id) : [];
  const rowYears = new Map<number, number | null>();
  for (const a of assignments) {
    rowYears.set(a.id, a.target_year ?? yearOf(a.target_date));
  }
  const matchYears = new Set<number>();
  for (const y of rowYears.values()) if (typeof y === 'number') matchYears.add(y);
  // Bila batch tidak memberi tahun sama sekali, jangan saring apa pun.
  const yearScope = matchYears.size ? matchYears : null;

  const visits = await store.allVisits();
  /**
   * Nama pasien boleh diambil dari kunjungan tahun mana pun: nama itu identitas, bukan bukti
   * pekerjaan. Bukti "Diinput" tetap dibatasi tahun penugasan lewat indexVisits.
   */
  const nameByNik = new Map<string, string>();
  const nameByDob = new Map<string, string>();
  for (const v of visits) {
    const nm = String(v.name_raw ?? '').trim();
    if (!nm) continue;
    const nik = normalizeNik(v.nik);
    if (nik && !nameByNik.has(nik)) nameByNik.set(nik, nm);
  }

  const idx = indexVisits(visits.map((v) => ({
    reg_id: v.reg_id,
    self_check_status: v.self_check_status,
    screening_count_all: v.screening_count_all,
    screening_count_done: v.screening_count_done,
    patient: { nik: v.nik, fullname: v.name_raw, birth_date: v.birth_date },
    register_date: v.register_date,
  })), yearScope ?? undefined);
  const visitsMatched = yearScope
    ? visits.filter((v) => {
        const y = yearOf(v.register_date);
        return y !== null && yearScope.has(y);
      }).length
    : visits.length;

  const rows: ReportRow[] = [];
  const details = await store.visitDetails();
  if (batch) {
    for (const a of assignments) {
      const nik = normalizeNik(a.patient_nik);
      const verdict = matchVerdict(
        { nik, name: a.patient_name ?? '', birthDate: a.birth_date },
        idx.byNik,
        idx.byNameDob,
        rule,
      );
      // Nama dari Excel menang; bila kosong, ambil dari kunjungan mana pun yang punya NIK sama.
      const fallbackName = nik ? (nameByNik.get(nik) ?? null) : null;
      const name = a.patient_name || fallbackName;
      const nameSource = a.patient_name ? 'excel' : (fallbackName ? 'ssi' : null);
      const detail = verdict.matchedRegIds.map((id) => details.get(id)).find((d) => d !== undefined);
      rows.push({
        assignmentId: a.id, rowNo: a.row_no, petugas: a.petugas,
        nik, name, nameSource, birthDate: a.birth_date, targetDate: a.target_date,
        year: rowYears.get(a.id) ?? null, verdict,
        layanan: detail ? { submitted: detail.servicesSubmitted, total: detail.servicesTotal } : null,
        failReason: a.fail_reason ?? null,
        failReasonLabel: failReasonLabel(a.fail_reason) || null,
        bucket: bucketOf({ verdict, failReason: a.fail_reason ?? null }),
        note: a.note ?? null,
        flaggedBy: a.flagged_by ?? null,
        flaggedAt: a.flagged_at ?? null,
      });
    }
  }

  // Filter tahun bekerja pada baris; daftar tahun selalu dari seluruh batch supaya pilihan tidak hilang.
  const years = [...new Set(rows.map((r) => r.year).filter((y): y is number => typeof y === 'number'))].sort((a, b) => b - a);
  const scoped = year ? rows.filter((r) => r.year === year) : rows;
  const { totals, perPetugas } = aggregateByPetugas(scoped);
  // Tanda setoran dicatat per petugas; statusnya tidak mengubah angka, hanya menjelaskan
  // mengapa sisa pasien petugas itu berstatus "Data Hilang".
  const submissions = batch ? await store.submissionsOf(batch.id) : new Map<string, { at: string; by: string | null; hitungGagal: boolean }>();
  for (const p of perPetugas) {
    const sub = submissions.get(p.petugas);
    if (!sub) continue;
    p.submitted = true;
    p.submittedAt = sub.at;
    p.includesGagal = sub.hitungGagal;
  }
  const lastRun = await store.lastRun();
  return {
    ruleVersion: RULE_VERSION,
    matchRule: rule,
    dasarHitungan: MATCH_RULES.find((r) => r.code === rule)?.label ?? rule,
    years,
    year: year ?? null,
    batchName: batchRow?.name ?? null,
    batch: batchRow
      ? {
          id: batchRow.id,
          name: batchRow.name ?? `Batch ${batchRow.id}`,
          periodStart: batchRow.period_start ?? null,
          periodEnd: batchRow.period_end ?? null,
          status: batchRow.status ?? 'aktif',
          imports: Number(batchRow.import_count ?? 0),
          lastImportAt: batchRow.last_import_at ?? batchRow.imported_at ?? null,
        }
      : null,
    generatedAt: new Date().toISOString(),
    batchId: batch?.id ?? null,
    totals,
    // Urut capaian (diinput + gagal), bukan sekadar jumlah input. Bila persentase sama,
    // yang jumlah inputnya lebih banyak naik: 65 orang selesai mengalahkan 42 orang dengan
    // persentase yang sama, baru setelah itu diurutkan menurut nama.
    perPetugas: perPetugas.sort((a, b) =>
      b.pctCapaian - a.pctCapaian || b.diinput - a.diinput || a.assigned - b.assigned || a.petugas.localeCompare(b.petugas)),
    rows: scoped,
    lastSyncAt: lastRun?.finished_at ?? null,
    visitCount: visits.length,
    matchYears: yearScope ? [...yearScope].sort() : null,
    visitsMatched,
    submissions: [...submissions].map(([petugas, v]) => ({ petugas, ...v })),
  };
}

/**
 * Ekspor daftar pasien apa adanya: NIK penuh (tidak disensor seperti di layar) supaya
 * bisa dipakai untuk menagih atau mencocokkan ulang di luar aplikasi.
 */
export async function exportPatientsToExcel(
  rows: ReportRow[],
  meta: { batchName: string | null; year: number | null; petugas: string | null; status: string | null; query: string | null },
  outPath: string,
) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Daftar Pasien');
  ws.columns = [
    { header: 'Petugas', key: 'petugas', width: 28 },
    { header: 'Nama pasien', key: 'name', width: 30 },
    { header: 'Sumber nama', key: 'nameSource', width: 12 },
    { header: 'NIK', key: 'nik', width: 20 },
    { header: 'Tgl lahir', key: 'birthDate', width: 12 },
    { header: 'Tahun', key: 'year', width: 8 },
    { header: 'Tgl target', key: 'targetDate', width: 12 },
    { header: 'Hasil', key: 'hasil', width: 18 },
    { header: 'Sebab gagal', key: 'failReason', width: 22 },
    { header: 'Catatan', key: 'note', width: 28 },
    { header: 'Screening', key: 'screening', width: 11 },
    { header: 'Tgl kunjungan', key: 'registerDate', width: 14 },
    { header: 'Ditandai oleh', key: 'flaggedBy', width: 16 },
  ];
  for (const r of rows) {
    ws.addRow({
      petugas: r.petugas,
      name: r.name ?? '',
      nameSource: r.nameSource === 'excel' ? 'Excel' : r.nameSource === 'ssi' ? 'SSI' : '',
      nik: r.nik ?? '',
      birthDate: r.birthDate ?? '',
      year: r.year ?? '',
      targetDate: r.targetDate ?? '',
      hasil: BUCKET_LABEL[r.bucket],
      failReason: r.failReasonLabel ?? '',
      note: r.note ?? '',
      screening: r.verdict.screeningAll ? `${r.verdict.screeningDone}/${r.verdict.screeningAll}` : '',
      registerDate: r.verdict.registerDate ? String(r.verdict.registerDate).slice(0, 10) : '',
      flaggedBy: r.flaggedBy ?? '',
    });
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: 'M1' };

  // Ringkasan filter di sheet kedua supaya file tidak bisa disalahartikan.
  const info = wb.addWorksheet('Info');
  info.columns = [{ width: 26 }, { width: 60 }];
  [
    ['Batch', meta.batchName ?? '-'],
    ['Tahun', meta.year ? String(meta.year) : 'semua tahun'],
    ['Petugas', meta.petugas ?? 'semua petugas'],
    ['Hasil', meta.status ? (BUCKET_LABEL[meta.status as Bucket] ?? meta.status) : 'semua hasil'],
    ['Pencarian', meta.query ?? '-'],
    ['Jumlah baris', String(rows.length)],
    ['Dicetak', new Date().toISOString().slice(0, 16).replace('T', ' ')],
  ].forEach(([k, v], i) => {
    info.getCell(i + 1, 1).value = k;
    info.getCell(i + 1, 1).font = { bold: true };
    info.getCell(i + 1, 2).value = v;
  });

  await wb.xlsx.writeFile(outPath);
}

export async function exportReportToExcel(report: Report, outPath: string) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();

  const s1 = wb.addWorksheet('Rekap Petugas');
  s1.columns = [
    { header: 'Petugas', key: 'petugas', width: 30 },
    { header: 'Ditugaskan', key: 'assigned', width: 12 },
    { header: 'Ada di SSI', key: 'ada', width: 12 },
    { header: 'Lengkap', key: 'lengkap', width: 10 },
    { header: 'Sebagian', key: 'sebagian', width: 11 },
    { header: 'Belum', key: 'belum', width: 10 },
    { header: 'Ambigu', key: 'ambigu', width: 10 },
    { header: 'Diinput', key: 'diinput', width: 10 },
    { header: 'Gagal input', key: 'gagalDitandai', width: 12 },
    { header: 'Tidak valid', key: 'tidakValid', width: 11 },
    { header: 'Faskes lain', key: 'faskesLain', width: 11 },
    { header: 'Data hilang', key: 'dataHilang', width: 11 },
    { header: 'Belum diinput', key: 'perluTindakan', width: 14 },
    { header: 'Selesai', key: 'selesai', width: 10 },
    { header: '% Capaian', key: 'pctCapaian', width: 11 },
    { header: '% Diinput saja', key: 'pctLengkap', width: 13 },
  ];
  for (const p of report.perPetugas) s1.addRow(p);
  s1.addRow(report.totals);
  s1.getRow(1).font = { bold: true };

  const s2 = wb.addWorksheet('Detail');
  s2.columns = [
    { header: 'Petugas', key: 'petugas', width: 28 },
    { header: 'Nama', key: 'name', width: 32 },
    { header: 'Sumber nama', key: 'nameSource', width: 13 },
    { header: 'NIK', key: 'nik', width: 20 },
    { header: 'Tgl Lahir', key: 'birthDate', width: 12 },
    { header: 'Tgl Target', key: 'targetDate', width: 12 },
    { header: 'Hasil', key: 'hasil', width: 18 },
    { header: 'Status SSI', key: 'status', width: 18 },
    { header: 'Ada', key: 'ada', width: 7 },
    { header: 'Lengkap', key: 'lengkap', width: 9 },
    { header: 'Screening', key: 'screening', width: 12 },
    { header: 'Layanan', key: 'layanan', width: 12 },
    { header: 'Reg ID', key: 'regIds', width: 40 },
    { header: 'Metode', key: 'method', width: 16 },
    { header: 'Sebab gagal', key: 'failReason', width: 26 },
    { header: 'Catatan pegawai', key: 'note', width: 30 },
    { header: 'Ditandai oleh', key: 'flaggedBy', width: 16 },
  ];
  for (const r of report.rows) {
    s2.addRow({
      petugas: r.petugas, name: r.name, nameSource: r.nameSource ?? '', nik: r.nik, birthDate: r.birthDate, targetDate: r.targetDate,
      status: r.verdict.status, ada: r.verdict.ada ? 'ya' : 'tidak', lengkap: r.verdict.lengkap ? 'ya' : 'tidak',
      screening: r.verdict.screeningAll ? `${r.verdict.screeningDone}/${r.verdict.screeningAll}` : '',
      layanan: r.layanan ? `${r.layanan.submitted}/${r.layanan.total}` : '',
      regIds: r.verdict.matchedRegIds.join(', '), method: r.verdict.method,
      hasil: BUCKET_LABEL[r.bucket],
      failReason: r.failReasonLabel ?? (r.verdict.status === 'LENGKAP' ? '' : 'perlu ditagih'),
      note: r.note ?? '',
      flaggedBy: r.flaggedBy ?? '',
    });
  }
  s2.getRow(1).font = { bold: true };
  s2.views = [{ state: 'frozen', ySplit: 1 }];

  await wb.xlsx.writeFile(outPath);
}
