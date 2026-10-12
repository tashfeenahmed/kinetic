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
  branching?: Branching | null;
  ab_test?: AbConfig | null;
  ab_winner_step_id?: number | null;
}

// ---- conditional sequences ----
export type Condition =
  | { type: 'opened'; negate?: boolean; scope?: 'previous' | 'any' }
  | { type: 'clicked'; negate?: boolean; scope?: 'previous' | 'any'; url?: string }
  | { type: 'replied'; negate?: boolean }
  | { type: 'reply_category'; value: 'interested' | 'not_interested'; negate?: boolean }
  | { type: 'lead_field'; field: string; op: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'empty' | 'not_empty' | 'gt' | 'lt'; value?: string | number }
  | { type: 'email_provider'; value: 'google' | 'microsoft' | 'other'; negate?: boolean }
  | { type: 'has_tag'; tag: string; negate?: boolean }
  | { type: 'day_of_week'; days: Weekday[] }
  | { type: 'time_since_previous'; op: 'gt' | 'lt'; days: number };

export type Action =
  | { type: 'continue' }
  | { type: 'jump'; step: number }
  | { type: 'skip' }
  | { type: 'wait'; days: number }
  | { type: 'end' }
  | { type: 'move'; campaign_id: number }
  | { type: 'add_tag'; tag: string };

export interface Rule { when: Condition[]; match: 'all' | 'any'; then: Action }
export interface Branching { rules: Rule[]; else: Action; check_after_days?: number; max_visits?: number }

// ---- A/B tests ----
export type AbMetric = 'reply_rate' | 'interested_rate' | 'positive_reply_rate' | 'open_rate' | 'click_rate';
export interface AbConfig {
  enabled: boolean;
  metric: AbMetric;
  min_sends_per_variant: number;
  reply_wait_days: number;
  confidence: number;
  pool: 'all' | 'percent';
  test_percent: number;
}
export const AB_DEFAULTS: AbConfig = { enabled: true, metric: 'reply_rate', min_sends_per_variant: 100, reply_wait_days: 3, confidence: 0.95, pool: 'all', test_percent: 20 };

export interface VariantStats {
  id: number;
  letter: string;
  is_main: boolean;
  email_subject: string;
  active: boolean;
  sent: number;
  opens: number;
  clicks: number;
  replies: number;
  interested: number;
  positive_replies: number;
  bounces: number;
  open_rate: number;
  click_rate: number;
  reply_rate: number;
  interested_rate: number;
  positive_reply_rate: number;
  bounce_rate: number;
  mature_sent: number;
  metric_rate: number;
  confidence: number | null;
  is_leader: boolean;
  is_winner: boolean;
}

export interface AbTest {
  step_id: number;
  step_order: number;
  config: AbConfig;
  status: 'running' | 'decided' | 'manual';
  winner_step_id: number | null;
  decided_at: string | null;
  leader_step_id: number | null;
  p_value: number | null;
  reason: string;
  open_tracking_off: boolean;
  click_tracking_off: boolean;
  variants: VariantStats[];
  decision: { id: number; decided_by: 'auto' | 'manual'; p_value: number | null; confidence: number | null; created_at: string; note: string } | null;
}

export const METRIC_LABELS: Record<AbMetric, string> = {
  reply_rate: 'Reply rate', interested_rate: 'Interested rate', positive_reply_rate: 'Positive reply rate', open_rate: 'Open rate', click_rate: 'Click rate',
};

export const variantLetter = (i: number) => String.fromCharCode(65 + i);
