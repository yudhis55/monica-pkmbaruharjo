/**
 * Ambil rincian satu kunjungan dari SSI.
 *
 * `list-kunjungan-umum` hanya memberi `screening_count_done/all`, yang menghitung
 * **formulir skrining langsung**, bukan layanan. Terbukti pada data nyata:
 * satu kunjungan berstatus `Lengkap` dengan form 9/9 bisa punya 0/14 layanan terkirim.
 * Angka layanan hanya ada di endpoint rincian, jadi harus diambil per kunjungan.
 */
import { ssiPost, type SsiAuth } from './client.ts';
import { summarizeDetail, type DetailPayload, type VisitDetail } from './detailParse.ts';

export const DETAIL_PATH = '/api/pkg/ssi/detail-screening-ssi';
export type { VisitDetail } from './detailParse.ts';

export async function fetchVisitDetail(auth: SsiAuth, regId: string): Promise<VisitDetail> {
  const payload = (await ssiPost(DETAIL_PATH, { reg_id: regId }, auth)) as DetailPayload;
  if (!payload?.data) throw new Error('rincian kosong dari SSI');
  return summarizeDetail(regId, payload);
}
