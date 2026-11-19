/**
 * Pengurai payload rincian kunjungan. Murni: tanpa jaringan, tanpa impor klien,
 * supaya bisa diuji dengan `node --experimental-strip-types`.
 */

export interface VisitDetail {
  regId: string;
  servicesTotal: number;
  servicesSubmitted: number;
  formsTotal: number | null;
  formsSubmitted: number | null;
  selfCheckStatus: string | null;
  fetchedAt: string;
}

interface Pemeriksaan {
  is_submit_form?: boolean;
}

interface Layanan {
  list_pemeriksaan?: Pemeriksaan[];
}

export interface DetailPayload {
  data?: {
    reg_id?: string;
    self_check_status?: string | null;
    screening_count_all?: number | null;
    screening_count_done?: number | null;
    screening_layanan?: Layanan[] | null;
  } | null;
}

export function summarizeDetail(regId: string, payload: DetailPayload, fetchedAt = new Date().toISOString()): VisitDetail {
  const d = payload.data ?? {};
  const services = d.screening_layanan ?? [];
  let submitted = 0;
  for (const svc of services) {
    const items = svc.list_pemeriksaan ?? [];
    if (items.some((p) => p.is_submit_form === true)) submitted++;
  }
  return {
    regId,
    servicesTotal: services.length,
    servicesSubmitted: submitted,
    formsTotal: typeof d.screening_count_all === 'number' ? d.screening_count_all : null,
    formsSubmitted: typeof d.screening_count_done === 'number' ? d.screening_count_done : null,
    selfCheckStatus: d.self_check_status ?? null,
    fetchedAt,
  };
}
