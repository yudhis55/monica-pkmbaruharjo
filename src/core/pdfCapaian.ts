/**
 * PDF capaian entry petugas — satu halaman A4 landscape, dibuat tanpa dependensi luar.
 *
 * Yang ditulis sendiri hanya bagian yang benar-benar dipakai: font standar PDF (Times-Roman
 * "WinAnsiEncoding", yang memuat huruf beraksen seperti é/ñ, cukup untuk nama petugas),
 * teks rata kiri, garis tabel, dan pengisi blok warna untuk bar capaian.
 * Huruf non-Latin diganti "?" — nama petugas puskesmas praktis selalu ASCII.
 */

export interface PdfPetugasRow {
  petugas: string;
  assigned: number;
  diinput: number;
  /** Sudah ditandai gagal diinput (data tidak valid / faskes lain): dianggap selesai. */
  gagal: number;
  /** Masih harus ditagih: ditugaskan dikurangi diinput dan gagal. */
  belum: number;
  pct: number;
}

export interface PdfCapaianInput {
  title: string;
  /** Baris identitas: satu pasangan label/nilai per baris. */
  meta: Array<[string, string]>;
  rows: PdfPetugasRow[];
  total: PdfPetugasRow;
}

type Cell = { s: string; x: number; y: number; size: number; bold?: boolean; align?: 'left' | 'right' };

/** Hanya karakter yang pasti ada di WinAnsiEncoding dan tidak perlu escape. */
function pdfText(raw: string): string {
  return String(raw ?? '')
    .normalize('NFKD')
    // Tanda pisah tipis/en/em dash jadi "-" supaya tidak berubah menjadi "?" di pembaca PDF.
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '-')
    .replace(/[\\()]/g, (c) => '\\' + c);
}

const num = (n: number) => new Intl.NumberFormat('id-ID').format(Math.round(n));
const pct = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',') + '%';

function width(text: string, size: number, bold: boolean): number {
  // Perkiraan lebar Helvetica: rata-rata 0.52 em, angka 0.556 em. Cukup untuk menyusun kolom.
  return text.length * size * (bold ? 0.56 : 0.52);
}

function buildContent(
  input: PdfCapaianInput,
  pageW: number,
  pageH: number,
  rows: PdfPetugasRow[],
  total: PdfPetugasRow | null,
  footNote: string | null,
): string {
  const left = 36;
  const right = pageW - 36;
  const top = pageH - 40;
  const out: string[] = [];

  const cell = (c: Cell) => {
    const t = pdfText(c.s);
    const w = width(t, c.size, Boolean(c.bold));
    const x = c.align === 'right' ? c.x - w : c.x;
    // Warna teks ditulis per string: tanpa ini, teks setelah bar abu-abu ikut terwarnai
    // karena operator pengisi warna `rg` bertahan sampai diubah.
    return `0 0 0 rg BT /${c.bold ? 'F2' : 'F1'} ${c.size} Tf ${x.toFixed(1)} ${c.y.toFixed(1)} Td (${t}) Tj ET`;
  };
  const line = (x1: number, y1: number, x2: number, y2: number, gray = 0.75) =>
    `${gray.toFixed(2)} G 0.6 w ${x1.toFixed(1)} ${y1.toFixed(1)} m ${x2.toFixed(1)} ${y2.toFixed(1)} l S`;
  const rect = (x: number, y: number, w: number, h: number, r: number, g: number, b: number) =>
    `${r.toFixed(2)} ${g.toFixed(2)} ${b.toFixed(2)} rg ${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  // Judul + garis + baris identitas (label rata kiri dalam lebar tetap agar nilai rata).
  const baseline = top - 2;
  out.push(cell({ s: input.title, x: left, y: baseline, size: 16, bold: true }));
  const ruleY = baseline - 9;
  out.push(line(left, ruleY, right, ruleY, 0.35));

  const labelW = 92;
  const metaSize = 9;
  input.meta.forEach(([label, value], i) => {
    const y = ruleY - 16 - i * 13;
    out.push(cell({ s: label, x: left, y, size: metaSize, bold: true }));
    out.push(cell({ s: value, x: left + labelW, y, size: metaSize }));
  });

  // Kolom angka rata kanan; nama di kiri; bar capaian paling kanan.
  const barW = 132;
  const colPct = right - barW - 42;
  const colBelum = colPct - 52;
  const colGagal = colBelum - 44;
  const colDiinput = colGagal - 44;
  const colAssigned = colDiinput - 56;
  const headY = ruleY - 16 - input.meta.length * 13 - 14;
  const headSize = 9;
  const nameLeft = left;

  // Ukuran baris mengikuti sisa halaman. Nama panjang boleh dua baris, jadi yang
  // dibatasi adalah tinggi, bukan jumlah nama. Batas 17pt menjaga jarak antar baris
  // supaya nama baris berikutnya tidak tertutup garis dan bar capaian.
  const bottomGap = 34;
  // +1 hanya bila baris total ikut dicetak: halaman pertama (tanpa total) bisa memuat
  // satu baris lebih banyak daripada halaman terakhir.
  const rowH = Math.min(17, (headY - bottomGap) / Math.max(rows.length + (total ? 1 : 0), 1));
  const size = rowH < 9 ? 6 : rowH < 10 ? 6.5 : rowH < 12.5 ? 7.5 : rowH < 15 ? 9 : 10;
  // Kalau baris sangat rapat, nama panjang dipotong dengan ".." daripada bertumpuk
  // ke baris di atasnya (baris 6pt tidak bisa memuat dua baris teks).
  const allowWrap = rowH >= size * 2.2;

  const nameBudget = colAssigned - nameLeft - 14;
  const nameMaxChars = Math.max(18, Math.floor(nameBudget / (size * 0.52)));
  const fit = (s: string) => (s.length <= nameMaxChars ? s : s.slice(0, Math.max(4, nameMaxChars - 2)) + '..');
  const wrap = (s: string) => {
    if (!allowWrap) return [fit(s)];
    if (s.length <= nameMaxChars) return [s];
    const words = s.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if (!cur) cur = w;
      else if ((cur + ' ' + w).length <= nameMaxChars) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 2).map((l, i, arr) => (i === arr.length - 1 ? fit(l) : l));
  };

  out.push(cell({ s: 'Petugas', x: nameLeft, y: headY, size: headSize, bold: true }));
  out.push(cell({ s: 'Ditugaskan', x: colAssigned, y: headY, size: headSize, bold: true, align: 'right' }));
  out.push(cell({ s: 'Diinput', x: colDiinput, y: headY, size: headSize, bold: true, align: 'right' }));
  out.push(cell({ s: 'Gagal', x: colGagal, y: headY, size: headSize, bold: true, align: 'right' }));
  out.push(cell({ s: 'Belum', x: colBelum, y: headY, size: headSize, bold: true, align: 'right' }));
  out.push(cell({ s: 'Capaian', x: colPct, y: headY, size: headSize, bold: true, align: 'right' }));
  out.push(line(nameLeft, headY - 5, right, headY - 5, 0.4));

  // Bar: latar abu-abu sama untuk tiap baris (baris tidak "memudar" di bawah).
  const barY = (base: number) => base - 1.5;

  let y = headY - 5 - rowH;
  for (const r of rows) {
    const base = y + (rowH - size) / 2 + 1;
    const lines = wrap(r.petugas);
    lines.forEach((t, i) => {
      out.push(cell({ s: t, x: nameLeft, y: base + (lines.length - 1 - i) * (size + 0.5), size }));
    });
    out.push(cell({ s: num(r.assigned), x: colAssigned, y: base, size, align: 'right' }));
    out.push(cell({ s: num(r.diinput), x: colDiinput, y: base, size, align: 'right' }));
    out.push(cell({ s: num(r.gagal), x: colGagal, y: base, size, align: 'right' }));
    out.push(cell({ s: num(r.belum), x: colBelum, y: base, size, align: 'right' }));
    out.push(cell({ s: pct(r.pct), x: colPct, y: base, size, align: 'right' }));
    const bx = colPct + 8;
    out.push(rect(bx, barY(base), barW, 4, 0.85, 0.85, 0.85));
    if (r.pct > 0) out.push(rect(bx, barY(base), Math.max(1, barW * clamp01(r.pct / 100)), 4, 0.13, 0.13, 0.13));
    out.push(line(nameLeft, y, right, y, 0.9));
    y -= rowH;
  }

  // Baris total — hanya dicetak sekali, di halaman terakhir.
  if (total) {
    const totalBase = y + (rowH - size) / 2 + 1;
    out.push(line(nameLeft, y + rowH - 2, right, y + rowH - 2, 0.35));
    out.push(cell({ s: total.petugas, x: nameLeft, y: totalBase, size, bold: true }));
    out.push(cell({ s: num(total.assigned), x: colAssigned, y: totalBase, size, bold: true, align: 'right' }));
    out.push(cell({ s: num(total.diinput), x: colDiinput, y: totalBase, size, bold: true, align: 'right' }));
    out.push(cell({ s: num(total.gagal), x: colGagal, y: totalBase, size, bold: true, align: 'right' }));
    out.push(cell({ s: num(total.belum), x: colBelum, y: totalBase, size, bold: true, align: 'right' }));
    out.push(cell({ s: pct(total.pct), x: colPct, y: totalBase, size, bold: true, align: 'right' }));
    const tbx = colPct + 8;
    out.push(rect(tbx, barY(totalBase), barW, 4, 0.85, 0.85, 0.85));
    if (total.pct > 0) out.push(rect(tbx, barY(totalBase), Math.max(1, barW * clamp01(total.pct / 100)), 4, 0.13, 0.13, 0.13));
  }

  // Catatan kaki: nomor halaman, supaya cetakan berlembar tidak tertukar.
  if (footNote) {
    out.push(cell({ s: footNote, x: left, y: 22, size: 8 }));
  }

  return out.join('\n');
}

/**
 * Rakit PDF dari satu atau beberapa halaman. Nomor objek: 1 katalog, 2 daftar halaman,
 * 3..(2+N) halaman, (3+N) isi tiap halaman, lalu dua font di akhir.
 */
function assemble(pages: string[], pageW: number, pageH: number): Buffer {
  const n = pages.length;
  const firstPageObj = 3;
  const firstContentObj = 3 + n;
  const font1 = firstContentObj + n;
  const font2 = font1 + 1;

  const kids = pages.map((_, i) => `${firstPageObj + i} 0 R`).join(' ');
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`,
  ];
  pages.forEach((_, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
        `/Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${firstContentObj + i} 0 R >>`,
    );
  });
  pages.forEach((content) => {
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * Tabel petugas harus muat satu halaman. Jika terlalu banyak, font dan tinggi baris
 * mengecil sampai batas terbaca; kalau masih tidak muat, lempar galat yang jelas
 * daripada menghasilkan PDF terpotong tanpa disadari.
 */
const A4_LANDSCAPE: [number, number] = [842, 595];
// 8.5pt: teks 7pt masih terbaca saat dicetak. Batas ini yang membuat 51 petugas
// tetap muat SATU halaman.
const MIN_ROW_H = 8.5;
// Ruang tetap dari atas: margin 40 + judul/garis 18 + 2 baris identitas 26 + header tabel 19 + dasar 34.
const RESERVED = 40 + 18 + 26 + 19 + 34;
export const PDF_MAX_ROWS = Math.floor((A4_LANDSCAPE[1] - RESERVED) / MIN_ROW_H) - 1;

/**
 * PDF capaian: satu halaman bila muat, lebih bila perlu. Dulu fungsi ini melempar galat
 * ketika petugas lebih dari 52 — artinya tombol "Unduh PDF" selalu gagal pada batch
 * normal (63 petugas). Sekarang daftar dipecah ke beberapa halaman dan baris total
 * dicetak di halaman terakhir.
 */
export function buildCapaianPdf(input: PdfCapaianInput): Buffer {
  const [w, h] = A4_LANDSCAPE;

  // Pecah baris per halaman. Halaman terakhir harus menyisakan satu tempat untuk
  // baris total; bila potongan terakhir tepat penuh, total pindah ke halaman tambahan.
  const chunks: PdfPetugasRow[][] = [];
  for (let i = 0; i < input.rows.length; i += PDF_MAX_ROWS) {
    chunks.push(input.rows.slice(i, i + PDF_MAX_ROWS));
  }
  if (!chunks.length) chunks.push([]);

  const lastChunk = chunks[chunks.length - 1];
  const totalOnOwnPage = lastChunk.length === PDF_MAX_ROWS;
  const pageCount = chunks.length + (totalOnOwnPage ? 1 : 0);

  const pages: string[] = [];
  chunks.forEach((chunk, i) => {
    const isLast = i === chunks.length - 1;
    const withTotal = isLast && !totalOnOwnPage ? input.total : null;
    pages.push(buildContent(input, w, h, chunk, withTotal, `Halaman ${i + 1} dari ${pageCount} — ${input.title}`));
  });
  if (totalOnOwnPage) {
    pages.push(buildContent(input, w, h, [], input.total, `Halaman ${pageCount} dari ${pageCount} — ${input.title}`));
  }
  return assemble(pages, w, h);
}
