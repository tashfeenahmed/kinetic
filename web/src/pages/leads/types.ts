export interface Tag { id: number; name: string; default?: boolean }
export interface LeadList { id: number; name: string; leads_count?: number }

export interface Lead {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  title: string;
  company: string;
  notes: string;
  status: string;
  custom_variables: { name: string; value: string }[];
  tags: Tag[];
  lead_list: LeadList | null;
  lead_list_id: number | null;
  overall_stats: { emails_sent: number; opens: number; clicks: number; replies: number };
  created_at: string;
  campaigns?: { id: number; name: string; campaign_status: string; status: string; current_step: number; last_sent_at: string | null; next_due_at: string | null }[];
}

export const LEAD_STATUSES = ['verified', 'unverified', 'unknown', 'risky', 'inactive', 'unsubscribed', 'bounced'] as const;

/** Reads a File as base64 (without the data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
