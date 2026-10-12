export interface CampaignStats {
  emails_sent: number;
  total_leads: number;
  total_leads_contacted: number;
  not_started: number;
  in_progress: number;
  completed: number;
  progress_percentage: number;
  opened: number;
  opened_percentage: number;
  unique_opens_per_contact: number;
  unique_opens_per_contact_percentage: number;
  clicked: number;
  unique_replies_per_contact: number;
  unique_replies_per_contact_percentage: number;
  total_replies: number;
  bounced: number;
  bounced_percentage: number;
  unsubscribed: number;
  unsubscribed_percentage: number;
  interested: number;
  interested_percentage: number;
}

export interface Campaign {
  id: number;
  workspace_id: number;
  name: string;
  type: 'outbound' | 'reply_followup';
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  max_emails_per_day: number;
  max_new_leads_per_day: number;
  daily_max_sends_per_receiving_domain: number;
  plain_text: boolean;
  open_tracking: boolean;
  click_tracking: boolean;
  can_unsubscribe: boolean;
  include_auto_replies_in_stats: boolean;
  sequence_prioritization: 'followups' | 'new_leads';
  stop_on_reply: boolean;
  custom_tracking_domain_id: number | null;
  schedule: Schedule;
  sequence_steps_count: number;
  sender_emails_count: number;
  tags: { id: number; name: string }[];
  stats: CampaignStats;
  launched_at: string | null;
  created_at: string;
  updated_at: string;
  next_window?: { start: string; end: string } | null;
}

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type Schedule = Record<Weekday, boolean> & { start_time: string; end_time: string; timezone: string };

export interface Variant {
  id?: number;
  email_subject: string;
  email_body: string;
  active: boolean;
}

export interface Step extends Variant {
  step_order?: number;
  wait_in_days: number;
  thread_reply: boolean;
  variants: Variant[];
}

export const variantLetter = (i: number) => String.fromCharCode(65 + i);
