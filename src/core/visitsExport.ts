import type { VisitExportRow } from './db/store.ts';

/**
 * Data mentah SSI: seluruh baris tabel `visit`. Berbeda dari `exportPatientsToExcel`
 * (yang hanya memuat pasien dari Excel penugasan), berkas ini juga memuat pasien yang
 * belum pernah dibagikan ke petugas — dipakai untuk memeriksa kelengkapan data sumber.
 */
export async function exportVisitsToExcel(
  rows: VisitExportRow[],
  meta: { year: number | null; syncedAt: string | null },
  outPath: string,
) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Kunjungan SSI');
  ws.columns = [
    { header: 'Reg ID', key: 'reg_id', width: 12 },
    { header: 'NIK', key: 'nik', width: 20 },
    { header: 'Nama (SSI)', key: 'name_raw', width: 30 },
    { header: 'Nama ternormalisasi', key: 'name_norm', width: 26 },
    { header: 'Tgl lahir', key: 'birth_date', width: 12 },
    { header: 'JK', key: 'gender', width: 5 },
    { header: 'Kode faskes', key: 'faskes_code', width: 13 },
    { header: 'Faskes', key: 'faskes_name', width: 22 },
    { header: 'No tiket', key: 'ticket_number', width: 18 },
    { header: 'Tgl daftar', key: 'register_date', width: 18 },
    { header: 'Status self check', key: 'self_check_status', width: 18 },
    { header: 'Screening (selesai/semua)', key: 'screening', width: 16 },
    { header: 'Tgl periksa', key: 'attend_date', width: 14 },
    { header: 'Tgl selesai', key: 'done_date', width: 14 },
    { header: 'Lengkap', key: 'is_complete', width: 9 },
    { header: 'Tgl kunjungan terdaftar', key: 'visit_register_date', width: 18 },
    { header: 'Tgl mulai', key: 'started_date', width: 14 },
    { header: 'Pertama terlihat', key: 'first_seen_at', width: 20 },
    { header: 'Terakhir terlihat', key: 'last_seen_at', width: 20 },
  ];
  for (const r of rows) {
    ws.addRow({
      reg_id: r.reg_id,
      nik: r.nik ?? '',
      name_raw: r.name_raw ?? '',
      name_norm: r.name_norm ?? '',
      birth_date: r.birth_date ?? '',
      gender: r.gender ?? '',
      faskes_code: r.faskes_code ?? '',
      faskes_name: r.faskes_name ?? '',
      ticket_number: r.ticket_number ?? '',
      register_date: r.register_date ?? '',
      self_check_status: r.self_check_status ?? '',
      screening: r.screening_count_all ? `${r.screening_count_done ?? 0}/${r.screening_count_all}` : '',
      attend_date: r.attend_date ?? '',
      done_date: r.done_date ?? '',
      is_complete: Number(r.is_complete) ? 'ya' : 'tidak',
      visit_register_date: r.visit_register_date ?? '',
      started_date: r.started_date ?? '',
      first_seen_at: r.first_seen_at ?? '',
      last_seen_at: r.last_seen_at ?? '',
    });
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: 'S1' };

  // Sheet kedua: asal-usul berkas, supaya tidak disalahartikan sebagai daftar penugasan.
  const info = wb.addWorksheet('Info');
  info.columns = [{ width: 26 }, { width: 60 }];
  [
    ['Sumber', 'Data mentah sinkronisasi SSI (tabel visit)'],
    ['Tahun', meta.year ? String(meta.year) : 'semua tahun'],
    ['Jumlah baris', String(rows.length)],
    ['Sinkronisasi terakhir', meta.syncedAt ?? '-'],
  ].forEach(([k, v]) => info.addRow([k, v]));
  info.getColumn(1).font = { bold: true };

  await wb.xlsx.writeFile(outPath);
}
