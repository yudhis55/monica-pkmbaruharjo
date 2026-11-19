/** Normalisasi identitas pasien. Aturan ini dipakai untuk matching dan harus stabil. */

/** NIK: hanya digit, 16 panjang. Selain itu dianggap tidak valid (110 baris di data nyata kosong). */
export function normalizeNik(input: unknown): string | null {
  const digits = String(input ?? '').replace(/\D+/g, '');
  return digits.length === 16 ? digits : null;
}

/**
 * Nama: uppercase, buang tanda baca, rapatkan spasi.
 * Data nyata punya 175 NIK dengan >1 ejaan ("MAKRONI"/"MUKRONI", spasi ganda).
 */
export function normalizeName(input: unknown): string {
  return String(input ?? '')
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tanggal ISO (YYYY-MM-DD). Menerima Date, serial Excel, atau string. */
export function normalizeDate(input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date && !Number.isNaN(input.getTime())) return toIsoDate(input);

  if (typeof input === 'number' && Number.isFinite(input)) {
    // Serial tanggal Excel (epoch 1899-12-30)
    const ms = Math.round((input - 25569) * 86_400_000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : toIsoDate(d);
  }

  const s = String(input).trim();
  const direct = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;

  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toIsoDate(d);
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Kunci identitas: NIK bila valid, jika tidak nama+tanggal lahir. */
export function identityKey(nik: string | null, name: string, birthDate: string | null): string {
  return nik ? `nik:${nik}` : `nm:${normalizeName(name)}|${birthDate ?? ''}`;
}
