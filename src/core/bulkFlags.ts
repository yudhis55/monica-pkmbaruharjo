import ExcelJS from 'exceljs';
import { normalizeNik } from './normalize.ts';
import { FAIL_REASONS, FLAG_LABEL } from './excel.ts';

/**
 * Tiga sebab gagal input yang boleh dilaporkan lewat file tanda massal. Sebab lain
 * (mis. "pasien menolak") memang harus dipilih satu per satu karena detailnya berbeda tiap pasien.
 *
 * `data_hilang` dipakai untuk klaim pegawai "sudah saya input" padahal data pasien tidak
 * muncul di SSI saat ditarik (galat sistem SSI). Buktinya ada di luar data SSI, jadi
 * hanya pegawai yang bisa menyatakannya.
 */
export const BULK_FLAG_REASONS = ['nik_tidak_valid', 'faskes_lain', 'data_hilang'] as const;
export type BulkFlagReason = (typeof BULK_FLAG_REASONS)[number];

export const BULK_FLAG_HEADERS = ['NIK', 'Alasan'] as const;
/** Satu ejaan untuk template Excel tanda dan template penugasan. */
export const BULK_REASON_LABEL = FLAG_LABEL;

/** Label (Indonesia, bebas kapitalisasi) atau kode → kode kanonik. */
export function parseBulkReason(raw: unknown): BulkFlagReason | null {
  const t = String(raw ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!t) return null;
  if (/^(data\s*)?hilang$/.test(t) || /^(data\s*)?hilang\s*(di|dari)\s*ssi$/.test(t)) return 'data_hilang';
  if (/^(tidak|tdk)\s*valid$|^data\s*(tidak|tdk)?\s*valid$|^invalid$|^nik\s*(tidak|tdk)?\s*valid$/.test(t)) return 'nik_tidak_valid';
  if (/^(faskes|lain)\s*lain$|^puskesmas\s*lain$|^fktp\s*lain$|^klinik\s*lain$/.test(t)) return 'faskes_lain';
  return null;
}

export interface BulkFlagRow {
  rowNo: number;
  nik: string;
  reason: BulkFlagReason;
}

export interface BulkFlagParse {
  rows: BulkFlagRow[];
  /** Baris yang tidak bisa dipakai, dengan sebabnya. */
  skipped: Array<{ rowNo: number; nik: string; reason: string }>;
  /** NIK yang muncul lebih dari sekali di file; baris terakhir dipakai. */
  duplicates: number;
  headers: string[];
}

/** Baca file tanda: header dicari di beberapa baris pertama (boleh ada judul di atasnya). */
export async function parseBulkFlagFile(path: string): Promise<BulkFlagParse> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('File tidak punya sheet.');

  let headerRow = 1;
  let cNik = -1;
  let cReason = -1;
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const values = (sheet.getRow(r).values as any[])
      .slice(1)
      .map((v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    const nikCol = values.findIndex((v) => v === 'nik' || v === 'nik pasien');
    const reasonCol = values.findIndex((v) => v.startsWith('alasan') || v === 'keterangan' || v === 'sebab');
    if (nikCol >= 0 && reasonCol >= 0) {
      headerRow = r; cNik = nikCol + 1; cReason = reasonCol + 1;
      break;
    }
  }
  if (cNik < 0 || cReason < 0) {
    throw new Error('Kolom "NIK" dan "Alasan" tidak ditemukan. Unduh template di halaman admin agar formatnya pasti.');
  }

  const rows: BulkFlagRow[] = [];
  const skipped: BulkFlagParse['skipped'] = [];
  const seen = new Map<string, number>();
  let duplicates = 0;

  sheet.eachRow({ includeEmpty: false }, (row, rowNo) => {
    if (rowNo <= headerRow) return;
    const rawNik = String(row.getCell(cNik).value ?? '').trim();
    const rawReason = String(row.getCell(cReason).value ?? '').trim();
    if (!rawNik && !rawReason) return; // baris kosong
    const nik = normalizeNik(rawNik);
    if (!nik) { skipped.push({ rowNo, nik: rawNik, reason: 'NIK wajib 16 digit' }); return; }
    const reason = parseBulkReason(rawReason);
    if (!reason) {
      skipped.push({ rowNo, nik, reason: `Alasan harus "Tidak Valid" atau "Faskes Lain" (dibaca: "${rawReason}")` });
      return;
    }
    if (seen.has(nik)) duplicates++;
    seen.set(nik, rowNo);
    rows.push({ rowNo, nik, reason });
  });

  // NIK ganda: hanya baris terakhir yang dipakai, sama seperti perilaku "unggah ulang".
  const last = new Map<string, BulkFlagRow>();
  for (const r of rows) last.set(r.nik, r);
  return { rows: [...last.values()], skipped, duplicates, headers: [BULK_FLAG_HEADERS[0], BULK_FLAG_HEADERS[1]] };
}

/** Template kosong: header + satu contoh baris + petunjuk isian. */
export async function writeBulkFlagTemplate(outPath: string, petugasList: string[] = []): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tanda tidak valid');
  ws.columns = [
    { header: BULK_FLAG_HEADERS[0], key: 'nik', width: 22 },
    { header: BULK_FLAG_HEADERS[1], key: 'reason', width: 18 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };

  // Validasi dropdown dua opsi: mengetik bebas tetap ditolak saat impor.
  for (let r = 2; r <= 500; r++) {
    ws.getCell(`B${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"' + BULK_FLAG_REASONS.map((c) => BULK_REASON_LABEL[c]).join(',') + '"'],
    };
  }
  const sheet2 = wb.addWorksheet('Petunjuk');
  sheet2.columns = [{ width: 100 }];
  const lines = [
    'Cara memakai file ini',
    '',
    '1. Isi kolom NIK (16 digit) dan kolom Alasan.',
    '2. Alasan hanya boleh: ' + BULK_FLAG_REASONS.map((c) => BULK_REASON_LABEL[c]).join(' / ') + '.',
    '3. Satu baris = satu NIK. NIK yang muncul lebih dari sekali: baris terakhir dipakai.',
    '4. Unggah file ini di halaman admin, panel "Tanda tidak valid (Excel)".',
    '5. Tanda hanya mengenai pasien yang ADA di batch aktif dan belum diinput.',
    '',
    'Arti setiap alasan',
    ...BULK_FLAG_REASONS.map((c) => '- ' + BULK_REASON_LABEL[c] + ': ' + FAIL_REASONS.find((r) => r.code === c)?.help),
    '',
    petugasList.length ? 'Petugas pada batch aktif: ' + petugasList.join(', ') : 'Petugas pada batch aktif: (belum ada batch)',
  ];
  lines.forEach((t, i) => { sheet2.getCell(i + 1, 1).value = t; });
  sheet2.getCell(1, 1).font = { bold: true };
  sheet2.getCell(9, 1).font = { bold: true };

  // Contoh baris ditulis di sheet petunjuk agar file utama tetap bersih untuk diisi.
  sheet2.getCell(15, 1).value = 'Contoh: 3503134405650002 | Tidak Valid';
  sheet2.getRow(15).font = { italic: true };

  await wb.xlsx.writeFile(outPath);
}

export interface BulkFlagApplyResult {
  matched: number;
  notInBatch: Array<{ nik: string; reason: string }>;
  alreadyDone: Array<{ nik: string; petugas: string; name: string | null }>;
  applied: Array<{ nik: string; petugas: string; name: string | null; reason: BulkFlagReason }>;
  /** Baris yang benar-benar ditulis ke DB (id + sebab). */
  chosen: Array<{ id: number; reason: BulkFlagReason }>;
}

/**
 * Terapkan tanda massal ke baris penugasan. Kunci yang dipakai di sini NIK saja
 * (template sengaja tidak meminta petugas), dengan urutan keputusan:
 * baris yang belum diinput dipilih lebih dulu, lalu baris tanpa tanda, lalu urutan petugas.
 * Baris yang sudah LENGKAP (sudah diinput) tidak ditandai: tidak ada yang gagal untuk diinput.
 */
export function applyBulkFlags(
  assignments: Array<{ id: number; petugas: string; nik: string | null; name: string | null; failReason: string | null }>,
  doneIds: Set<number>,
  flags: BulkFlagRow[],
): BulkFlagApplyResult {
  const byNik = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const nik = normalizeNik(a.nik);
    if (!nik) continue;
    const list = byNik.get(nik);
    if (list) list.push(a); else byNik.set(nik, [a]);
  }

  const result: BulkFlagApplyResult = { matched: 0, notInBatch: [], alreadyDone: [], applied: [], chosen: [] };
  for (const f of flags) {
    result.matched++;
    const candidates = byNik.get(f.nik);
    if (!candidates?.length) { result.notInBatch.push({ nik: f.nik, reason: 'NIK tidak ada di batch aktif' }); continue; }
    const rank = (a: (typeof assignments)[number]) => (doneIds.has(a.id) ? 2 : a.failReason ? 1 : 0);
    const ordered = [...candidates].sort((a, b) => rank(a) - rank(b) || a.petugas.localeCompare(b.petugas) || a.id - b.id);
    const pick = ordered[0];
    if (doneIds.has(pick.id)) {
      result.alreadyDone.push({ nik: f.nik, petugas: pick.petugas, name: pick.name });
      continue;
    }
    result.chosen.push({ id: pick.id, reason: f.reason });
    result.applied.push({ nik: f.nik, petugas: pick.petugas, name: pick.name, reason: f.reason });
  }
  return result;
}
