import ExcelJS from 'exceljs';
import { normalizeDate, normalizeNik, normalizeName } from './normalize.ts';

function pickFirst(headers: string[], patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const hit = headers.find((h) => h && re.test(h));
    if (hit) return hit;
  }
  return undefined;
}

export interface ColumnMapping {
  sheet?: string;
  headerRow?: number;
  nik?: string;
  nama?: string;
  petugas?: string;
  birthDate?: string;
  targetDate?: string;
  /** Kolom tanda dari pegawai: berisi alasan gagal input (lihat FAIL_REASONS). */
  status?: string;
  /** Kolom tahun penugasan; dipakai filter tahun di laporan. */
  year?: string;
}

export interface ImportedRow {
  rowNo: number;
  petugas: string;
  nik: string | null;
  name: string | null;
  birthDate: string | null;
  targetDate: string | null;
  /** Tahun penugasan dari kolom khusus, atau diturunkan dari tanggal target. */
  year: number | null;
  extra: Record<string, string>;
  /** Sebab gagal dari tanda pegawai, sudah dipetakan ke kode kanonik; null = tidak ditandai. */
  failReason: string | null;
  note: string | null;
  /** Nilai asli kolom tanda, untuk ditampilkan bila tidak dikenali. */
  rawStatus: string | null;
}

/**
 * Sebab gagal input yang dipakai aplikasi. Pegawai menandai di Excel dengan teks bebas;
 * setiap nilai dipetakan ke satu kode supaya laporan bisa dihitung.
 */
export const FAIL_REASONS: Array<{ code: string; label: string; help: string }> = [
  {
    code: 'nik_tidak_valid',
    label: 'Tidak Valid',
    help: 'SSI menolak saat pasien dicoba didaftarkan (NIK/data tidak valid).',
  },
  {
    code: 'faskes_lain',
    label: 'Faskes Lain',
    help: 'Pasien sudah dientry faskes/puskesmas lain, jadi tidak muncul di akun ini.',
  },
  { code: 'nik_tidak_terdaftar', label: 'NIK tidak terdaftar', help: 'NIK 16 digit tapi tidak ditemukan di SSI.' },
  {
    code: 'data_hilang',
    label: 'Data Hilang',
    help: 'Pegawai menyatakan sudah menginput, tapi data pasien tidak muncul di SSI saat ditarik.',
  },
  { code: 'pasien_tidak_ditemukan', label: 'Pasien tidak ditemukan', help: 'Pasien menolak, pindah, atau tidak hadir.' },
  { code: 'lainnya', label: 'Lainnya', help: 'Sebutkan di catatan.' },
];

const REASON_LABEL = new Map(FAIL_REASONS.map((r) => [r.code, r.label]));

/**
 * Ejaan baku tiga kategori yang dipakai di semua tempat manusia menulis/membaca:
 * template Excel, panel admin, dan dialog Tandai. Satu ejaan supaya file dan layar cocok.
 */
export const FLAG_LABEL: Record<string, string> = {
  nik_tidak_valid: 'Tidak Valid',
  faskes_lain: 'Faskes Lain',
  data_hilang: 'Data Hilang',
};

/**
 * Sebab yang boleh dipilih supervisor di layar. Sama dengan tiga kategori yang
 * disepakati: Tidak Valid, Faskes Lain, Data Hilang. Sebab lain tetap dikenali saat
 * membaca Excel lama (`mapFailReason`) supaya data lama tidak hilang, tetapi tidak
 * bisa dipilih untuk penandaan baru.
 */
export const MANUAL_REASONS: Array<{ code: string; label: string; help: string }> =
  ['nik_tidak_valid', 'faskes_lain', 'data_hilang'].map((code) => {
    const hit = FAIL_REASONS.find((r) => r.code === code)!;
    return { code: hit.code, label: hit.label, help: hit.help };
  });

/**
 * Map teks bebas dari kolom tanda pegawai ke kode kanonik.
 * Urutan penting: "sudah diinput faskes lain" mengandung kata "sudah diinput",
 * jadi frasa yang lebih spesifik diperiksa lebih dulu.
 */
export function mapFailReason(raw: string): string | null {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/^(ok|sudah|sudah diinput|selesai|berhasil|done|v|✓|1|ya)$/.test(t)) return null;
  if (/faskes\s*lain|puskesmas\s*lain|fktp\s*lain|klinik\s*lain|sudah\s*(di)?(entry|input|entri|terdaftar|didaftarkan).*(lain)|terdaftar.*lain/.test(t)) return 'faskes_lain';
  if (/data\s*(tidak|tdk)?\s*valid|tidak\s*valid|invalid|nik\s*(tidak|tdk)?\s*valid|nik\s*salah/.test(t)) return 'nik_tidak_valid';
  if (/^(data\s*)?hilang(\s*(di|dari)\s*ssi)?$/.test(t)) return 'data_hilang';
  if (/(tidak|tdk)\s*terdaftar|belum\s*terdaftar|tidak\s*ditemukan|tdk\s*ditemukan|tidak\s*ada/.test(t)) return 'nik_tidak_terdaftar';
  if (/tolak|menolak|tidak\s*bersedia|tidak\s*hadir|pindah|meninggal|meninggal dunia/.test(t)) return 'pasien_tidak_ditemukan';
  if (/gagal|belum|tidak|tdk|batal|error|salah/.test(t)) return 'lainnya';
  return 'lainnya';
}

export function failReasonLabel(code: string | null | undefined): string {
  if (!code) return '';
  return REASON_LABEL.get(code) ?? code;
}

export interface ImportResult {
  rows: ImportedRow[];
  headers: string[];
  skipped: Array<{ rowNo: number; reason: string; raw: Record<string, string> }>;
  sheets: string[];
}

const norm = (s: unknown) => normalizeName(s).replace(/\s+/g, '_');

export async function readWorkbook(path: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

/** Deteksi kolom otomatis: cari header yang mengandung nik / nama / petugas. */
export async function guessMapping(path: string): Promise<{ mapping: ColumnMapping; headers: string[]; sheets: string[]; samples: string[][] }> {
  const wb = await readWorkbook(path);
  const sheet = wb.worksheets[0];
  const sheets = wb.worksheets.map((w) => w.name);
  let headerRow = 1;
  let headers: string[] = [];
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const vals = (sheet.getRow(r).values as any[]).slice(1).map((v) => String(v ?? '').trim());
    const hit = vals.filter((v) => /nik|nama|petugas|tanggal|tgl/i.test(v)).length;
    if (hit >= 2) { headerRow = r; headers = vals; break; }
  }
  const mapping: ColumnMapping = {
    sheet: sheet.name,
    headerRow,
    nik: pickFirst(headers, [/\bnik\b/i, /nik/i]),
    nama: pickFirst(headers, [/nama\s*pasien/i, /nama\s*peserta/i, /^(nama|name)$/i, /nama(?!.*petugas)/i]) ?? pickFirst(headers, [/nama/i]),
    petugas: pickFirst(headers, [/nama\s*petugas/i, /petugas/i, /operator/i, /pegawai/i]),
    birthDate: pickFirst(headers, [/tanggal\s*lahir/i, /tgl\s*lahir/i, /lahir/i, /birth/i, /dob/i]),
    targetDate: pickFirst(headers, [/tanggal\s*target/i, /tgl\s*target/i, /tanggal\s*kunjungan/i, /tanggal(?!.*lahir)/i, /target/i]),
    status: pickFirst(headers, [/keterangan/i, /alasan/i, /catatan/i, /status\s*input/i, /tanda/i, /hasil/i, /gagal/i, /^status$/i, /cek/i, /verifikasi/i]),
    year: pickFirst(headers, [/^(tahun|periode|year)$/i, /tahun\s*(penugasan|anggaran|jalan)/i]),
  };
  const samples = sheet.getRows(headerRow + 1, Math.min(5, sheet.rowCount - headerRow))?.map(
    (r) => (r.values as any[]).slice(1).map((v) => String(v ?? '')),
  ) ?? [];
  return { mapping, headers, sheets, samples };
}

export async function importAssignments(path: string, mapping: ColumnMapping): Promise<ImportResult> {
  const wb = await readWorkbook(path);
  const sheet = mapping.sheet ? wb.getWorksheet(mapping.sheet) : wb.worksheets[0];
  if (!sheet) throw new Error(`Sheet "${mapping.sheet}" tidak ada`);

  const headerRowNo = mapping.headerRow ?? 1;
  const headerRow = sheet.getRow(headerRowNo);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => { headers[col] = String(cell.value ?? '').trim(); });

  const colIndex = (name?: string) => (name ? headers.indexOf(name) : -1);
  const cNik = colIndex(mapping.nik);
  const cNama = colIndex(mapping.nama);
  const cPetugas = colIndex(mapping.petugas);
  const cBirth = colIndex(mapping.birthDate);
  const cTarget = colIndex(mapping.targetDate);
  const cStatus = colIndex(mapping.status);
  const cYear = colIndex(mapping.year);

  // Kontrak tetap: Petugas + NIK 16 digit + Tahun. Nama tidak wajib karena boleh menyusul.
  if (cPetugas < 0) throw new Error('Kolom "Petugas" tidak ditemukan. Setiap baris harus punya nama penginput.');
  if (cNik < 0) throw new Error('Kolom "NIK" tidak ditemukan. Pencocokan ke SSI memakai NIK 16 digit.');
  if (cYear < 0 && cTarget < 0) throw new Error('Kolom "Tahun" tidak ditemukan. Tambahkan kolom Tahun (mis. 2026) atau Tanggal target.');

  const rows: ImportedRow[] = [];
  const skipped: ImportResult['skipped'] = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNo) => {
    if (rowNo <= headerRowNo) return;
    const get = (c: number) => (c >= 0 ? String(row.getCell(c).value ?? '').trim() : '');
    const petugas = get(cPetugas);
    const name = get(cNama) || null;
    const rawNik = get(cNik);
    const nik = normalizeNik(rawNik);

    if (!petugas && !name && !rawNik) return; // baris kosong
    if (!petugas) { skipped.push({ rowNo, reason: 'petugas kosong', raw: { name: name ?? '', nik: rawNik } }); return; }
    if (!name && !nik) { skipped.push({ rowNo, reason: 'nama dan NIK kosong', raw: { petugas } }); return; }
    // NIK wajib 16 digit. NIK cacat BUKAN "data tidak valid" versi SSI —
    // penolakan SSI hanya bisa diketahui setelah penginput mencoba mendaftarkan pasien.
    if (!nik) { skipped.push({ rowNo, reason: `NIK wajib 16 digit: "${rawNik}"`, raw: { petugas, name: name ?? '' } }); return; }

    // Duplikat tidak dibuang di sini: kuncinya NIK + Petugas dan diperiksa saat menyimpan,
    // supaya laporan bisa menyebut baris mana yang digabung.

    const rawStatus = cStatus >= 0 ? get(cStatus) : '';
    const failReason = mapFailReason(rawStatus);
    const targetDate = normalizeDate(get(cTarget));
    // Tahun penugasan: kolom khusus bila ada, kalau tidak ikut tanggal target.
    const rawYear = cYear >= 0 ? get(cYear) : '';
    const yearMatch = rawYear.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? Number(yearMatch[0]) : (targetDate ? Number(targetDate.slice(0, 4)) : null);

    rows.push({
      rowNo,
      petugas,
      nik,
      name,
      birthDate: normalizeDate(get(cBirth)),
      targetDate,
      year,
      extra: {},
      failReason,
      // Teks asli hanya disimpan bila pemetaan tidak persis sama dengan labelnya —
      // supaya alasan yang tidak dikenali tidak hilang dari layar.
      note: failReason && rawStatus && rawStatus.toLowerCase() !== failReasonLabel(failReason).toLowerCase() ? rawStatus : null,
      rawStatus: rawStatus || null,
    });
  });

  return { rows, headers: headers.filter(Boolean), skipped, sheets: wb.worksheets.map((w) => w.name) };
}

/** Kolom tetap template penugasan: urutan dan namanya sengaja paten agar pemetaan tidak menebak. */
export const ASSIGNMENT_TEMPLATE_HEADERS = [
  'Petugas', 'NIK', 'Tahun', 'Nama Pasien', 'Tanggal lahir', 'Tanggal target', 'Keterangan',
] as const;

/**
 * Template impor penugasan. Yang dikunci di sini: nama kolom, format NIK sebagai teks
 * (16 digit tidak berubah jadi notasi ilmiah), dan pilihan Keterangan berupa dropdown —
 * supaya isi file tidak bias dan pemetaan kolom tidak perlu ditebak.
 */
export async function writeAssignmentTemplate(
  outPath: string,
  petugasList: string[] = [],
  defaultYear: number | null = null,
): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();

  const ws = wb.addWorksheet('Penugasan');
  ws.columns = [
    { header: ASSIGNMENT_TEMPLATE_HEADERS[0], key: 'petugas', width: 26 },
    { header: ASSIGNMENT_TEMPLATE_HEADERS[1], key: 'nik', width: 20 },
    { header: ASSIGNMENT_TEMPLATE_HEADERS[2], key: 'tahun', width: 9 },
    { header: ASSIGNMENT_TEMPLATE_HEADERS[3], key: 'nama', width: 30 },
    { header: ASSIGNMENT_TEMPLATE_HEADERS[4], key: 'lahir', width: 14 },
    { header: ASSIGNMENT_TEMPLATE_HEADERS[5], key: 'target', width: 14 },
    { header: ASSIGNMENT_TEMPLATE_HEADERS[6], key: 'keterangan', width: 20 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: 'G1' };

  const MAX = 2000;
  // NIK selalu teks: 16 digit yang diperlakukan sebagai angka bisa tampil 3,50313E+15.
  for (let r = 2; r <= MAX; r++) {
    ws.getCell(`B${r}`).numFmt = '@';
    const tahun = ws.getCell(`C${r}`);
    if (defaultYear) tahun.value = defaultYear;
    tahun.numFmt = '0';
    ws.getCell(`G${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"' + MANUAL_REASONS.map((r2) => FLAG_LABEL[r2.code]).join(',') + '"'],
      showErrorMessage: true,
      errorTitle: 'Keterangan tidak dikenal',
      error: 'Pilih: ' + MANUAL_REASONS.map((r2) => FLAG_LABEL[r2.code]).join(', ') + '. Kosongkan bila pasien berhasil diinput.',
    };
  }

  const info = wb.addWorksheet('Petunjuk');
  info.columns = [{ width: 24 }, { width: 78 }];
  const lines: Array<[string, string]> = [
    ['Cara memakai', 'Isi satu baris per pasien di sheet "Penugasan". Jangan mengubah nama kolom.'],
    ['Petugas', 'WAJIB. Nama penginput; dipakai sebagai kunci pembagian tugas.'],
    ['NIK', 'WAJIB. 16 digit. Sudah diformat sebagai teks agar tidak berubah jadi angka.'],
    ['Tahun', 'WAJIB. Tahun penugasan (mis. ' + (defaultYear ?? new Date().getFullYear()) + ').'],
    ['Nama Pasien', 'Opsional. Bila kosong, nama diambil dari kunjungan SSI; bila tidak ada, tampil "-".'],
    ['Tanggal lahir', 'Opsional. Format YYYY-MM-DD atau DD/MM/YYYY.'],
    ['Tanggal target', 'Opsional. Dipakai sebagai tahun bila kolom Tahun kosong.'],
    ['Keterangan', 'Opsional. Pilih: ' + MANUAL_REASONS.map((r2) => FLAG_LABEL[r2.code]).join(' / ') +
      '. Kosongkan untuk pasien yang berhasil diinput (jangan menulis teks bebas lain).'],
    ['', ''],
    ['Unggah ulang', 'Mengganti seluruh isi batch: baris yang tidak ada di file akan dihapus. ' +
      'Unggah file yang memuat SEMUA pasien yang ingin dipertahankan, bukan sebagian.'],
    ['Tanda yang bertahan', 'Tanda manual (supervisor, tanda massal Excel, setoran) tetap tersimpan untuk NIK + Petugas yang sama. ' +
      'Tanda dari kolom Keterangan mengikuti isi file terakhir.'],
    ['Arti Keterangan', MANUAL_REASONS.map((r2) => FLAG_LABEL[r2.code] + ' = ' + r2.help).join('  |  ')],
    ['', ''],
    ['Contoh baris', 'SULISTRIYANI | 3503056302100001 | ' + (defaultYear ?? 2026) + ' | TUMINI | 1959-10-02 | | Faskes Lain'],
  ];
  lines.forEach(([k, v], i) => {
    const row = i + 1;
    if (k) {
      info.getCell(row, 1).value = k;
      info.getCell(row, 1).font = { bold: true };
    }
    info.getCell(row, 2).value = v;
    info.getCell(row, 2).alignment = { wrapText: true, vertical: 'top' };
  });

  if (petugasList.length) {
    const ref = wb.addWorksheet('Petugas');
    ref.columns = [{ header: 'Petugas pada batch aktif', key: 'p', width: 32 }];
    ref.getRow(1).font = { bold: true };
    for (const name of petugasList) ref.addRow([name]);
    ref.views = [{ state: 'frozen', ySplit: 1 }];
  }

  await wb.xlsx.writeFile(outPath);
}
