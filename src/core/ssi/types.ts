export interface SsiUser {
  user_id: string;
  fullname: string;
  faskes_code: string;
  partner_code: string;
  partner_category_code: string;
}

export interface SsiVisit {
  reg_id: string;
  faskes_code: string;
  faskes_name?: string;
  partner_code?: string;
  partner_name?: string;
  ticket_number?: string;
  register_date?: string;
  self_check_status?: string;
  screening_count_all?: number;
  screening_count_done?: number;
  is_report_available?: boolean;
  patient?: {
    nik?: string;
    fullname?: string;
    gender?: string;
    birth_date?: string;
    mobile_number?: string;
    age?: string;
  } | null;
  treatment?: {
    attend_date?: string | null;
    done_date?: string | null;
    finished_date?: string | null;
    register_date?: string | null;
    started_date?: string | null;
  } | null;
  wali?: {
    fullname?: string;
    birth_date?: string;
    mobile_number?: string;
  } | null;
}

export interface SsiPage {
  statusCode: number;
  data: {
    list: SsiVisit[];
    meta: { limit: number; page: number; total_data: number; total_page: number; fetched?: number };
  };
}

export interface StoredSession {
  tokenEksternal: string;
  refreshToken: string;
  userId?: string;
  faskesCode?: string;
  fullname?: string;
  updatedAt: string;
}
