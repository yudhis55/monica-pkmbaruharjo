import { normalizeName } from './normalize.ts';

/**
 * Verdict dua kolom (keputusan pengguna):
 *  - `ada`      : pasien ditemukan di SSI
 *  - `lengkap`  : ditemukan DAN screening selesai
 *
 * Aturan lengkap diturunkan dari angka, bukan dari self_check_status saja:
 * 472 baris berstatus "Lengkap" tanpa done_date, dan 215 "Belum Dilakukan" punya done_date.
 */
export type VerdictStatus = 'LENGKAP' | 'DIINPUT_SEBAGIAN' | 'BELUM_DIINPUT' | 'AMBIGU';

export interface SsiLike {
  reg_id: string;
  self_check_status?: string | null;
  screening_count_all?: number | null;
  screening_count_done?: number | null;
  patient?: { nik?: string | null; fullname?: string | null; birth_date?: string | null } | null;
  register_date?: string | null;
}

export interface MatchInput {
  nik: string | null;
  name: string;
  birthDate: string | null;
}

/**
 * Versi aturan dinaikkan saat pencocokan mulai dibatasi tahun penugasan.
 * v1: semua kunjungan dianggap bukti, berapa pun tahunnya.
 * v2: hanya kunjungan dengan `register_date` di tahun penugasan; tanpa tanggal = bukan bukti.
 */
export const RULE_VERSION = 'v2';

/** Tahun penugasan dari tanggal ISO (`YYYY-...`) atau angka. */
export function yearOf(value: unknown): number | null {
  const s = String(value ?? '').trim();
  const m = /^(\d{4})/.exec(s);
  return m ? Number(m[1]) : null;
}

/**
 * Syarat sebuah kunjungan dianggap bukti input. Diatur admin di halaman admin:
 * - `selesai`          : semua item screening selesai (aturan bawaan).
 * - `ada_atau_sebagian`: screening jalan (>=1 item) atau status Lengkap.
 * - `terdaftar`        : asal kunjungannya ada di tahun penugasan.
 */
export type MatchRule = 'selesai' | 'ada_atau_sebagian' | 'terdaftar';

export const MATCH_RULES: Array<{ code: MatchRule; label: string; help: string }> = [
  {
    code: 'selesai',
    label: 'Selesai (screening lengkap)',
    help: 'Semua item screening selesai. Paling ketat: "Belum lengkap" dan "Belum Dilakukan" dianggap belum diinput.',
  },
  {
    code: 'ada_atau_sebagian',
    label: 'Sudah ada pelayanan (>=1 item)',
    help: 'Kunjungan dengan minimal satu item screening dikerjakan, walaupun belum lengkap.',
  },
  {
    code: 'terdaftar',
    label: 'Asal data ada di tahun itu',
    help: 'Kunjungan didaftarkan di tahun penugasan, apa pun status screening-nya. Paling longgar.',
  },
];

export const DEFAULT_MATCH_RULE: MatchRule = 'selesai';

export function resolveMatchRule(code: string | null | undefined): MatchRule {
  return MATCH_RULES.some((r) => r.code === code) ? (code as MatchRule) : DEFAULT_MATCH_RULE;
}

/** True bila kunjungan memenuhi syarat bukti input di bawah `rule`. */
export function qualifies(visit: SsiLike, rule: MatchRule): boolean {
  if (rule === 'terdaftar') return true;
  if (rule === 'ada_atau_sebagian') return hasProgress(visit);
  return isComplete(visit);
}

export function isComplete(visit: SsiLike): boolean {
  const all = Number(visit.screening_count_all ?? 0);
  const done = Number(visit.screening_count_done ?? 0);
  if (all > 0 && done >= all) return true;
  return visit.self_check_status === 'Lengkap' && done > 0;
}

export function hasProgress(visit: SsiLike): boolean {
  return Number(visit.screening_count_done ?? 0) > 0 || visit.self_check_status === 'Lengkap';
}

export interface Verdict {
  status: VerdictStatus;
  ada: boolean;
  lengkap: boolean;
  matchedRegIds: string[];
  method: 'nik' | 'nama_tgl_lahir' | 'none';
  selfCheckStatus?: string | null;
  screeningDone?: number;
  screeningAll?: number;
  registerDate?: string | null;
}

/**
 * Match satu baris penugasan ke daftar kunjungan yang sudah diindeks.
 * Prioritas: NIK unik → fallback nama+tanggal lahir (hanya bila NIK tidak valid).
 */
export function matchVerdict(
  input: MatchInput,
  byNik: Map<string, SsiLike[]>,
  byNameDob: Map<string, SsiLike[]>,
  rule: MatchRule = DEFAULT_MATCH_RULE,
): Verdict {
  const empty = (status: VerdictStatus, method: Verdict['method']): Verdict => ({
    status, ada: false, lengkap: false, matchedRegIds: [], method,
  });

  let candidates: SsiLike[] = [];
  let method: Verdict['method'] = 'none';

  if (input.nik) {
    candidates = byNik.get(input.nik) ?? [];
    method = 'nik';
  }

  if (!input.nik) {
    const key = `${normalizeName(input.name)}|${input.birthDate ?? ''}`;
    const byName = key.endsWith('|') ? [] : (byNameDob.get(key) ?? []);
    if (byName.length === 0) return empty('AMBIGU', 'none');
    const nikSet = new Set(byName.map((v) => v.patient?.nik ?? '').filter(Boolean));
    // Nama+tanggal lahir menunjuk ke lebih dari satu NIK → tidak bisa diputuskan otomatis.
    if (nikSet.size > 1) {
      return { ...empty('AMBIGU', 'nama_tgl_lahir'), ada: true, matchedRegIds: byName.map((v) => v.reg_id) };
    }
    candidates = byName;
    method = 'nama_tgl_lahir';
  }

  if (candidates.length === 0) return empty('BELUM_DIINPUT', method);

  // "Best" tetap dipilih menurut kelengkapan supaya detail kunjungan yang ditampilkan bermakna.
  const bestVisit = candidates.find(isComplete) ?? candidates.find(hasProgress) ?? candidates[0];
  // Status monev mengikuti aturan admin; `lengkap` tetap berarti screening benar-benar selesai.
  const qualified = candidates.find((v) => qualifies(v, rule));
  const best = qualified ?? bestVisit;

  return {
    status: qualified ? 'LENGKAP' : hasProgress(bestVisit) ? 'DIINPUT_SEBAGIAN' : 'BELUM_DIINPUT',
    ada: true,
    lengkap: Boolean(qualified) && isComplete(bestVisit),
    matchedRegIds: candidates.map((v) => v.reg_id),
    method,
    selfCheckStatus: best.self_check_status ?? null,
    screeningDone: Number(best.screening_count_done ?? 0),
    screeningAll: Number(best.screening_count_all ?? 0),
    registerDate: best.register_date ?? null,
  };
}

/**
 * Indeks kunjungan untuk pencocokan. `years` membatasi kunjungan yang boleh jadi bukti:
 * kunjungan 2025 tidak boleh membuktikan penugasan 2026. Kunjungan tanpa `register_date`
 * tidak pernah dijadikan bukti (tidak bisa dipertanggungjawabkan saat ditagih).
 */
export function indexVisits(visits: SsiLike[], years?: Set<number>) {
  const byNik = new Map<string, SsiLike[]>();
  const byNameDob = new Map<string, SsiLike[]>();
  for (const v of visits) {
    if (years) {
      const y = yearOf(v.register_date);
      if (y === null || !years.has(y)) continue;
    }
    const nik = String(v.patient?.nik ?? '').trim();
    if (nik) {
      const list = byNik.get(nik);
      if (list) list.push(v); else byNik.set(nik, [v]);
    }
    const nm = normalizeName(v.patient?.fullname);
    const dob = String(v.patient?.birth_date ?? '').trim();
    if (nm && dob) {
      const key = `${nm}|${dob}`;
      const list = byNameDob.get(key);
      if (list) list.push(v); else byNameDob.set(key, [v]);
    }
  }
  return { byNik, byNameDob };
}
