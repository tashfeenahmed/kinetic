export interface Tag { id: number; name: string; default?: boolean }

export interface Sender {
  id: number;
  name: string;
  email: string;
  provider: 'google' | 'microsoft' | 'custom';
  auth_type: 'password' | 'oauth';
  imap_server: string | null;
  imap_port: number | null;
  imap_secure: boolean;
  smtp_server: string | null;
  smtp_port: number | null;
  smtp_secure: boolean;
  username: string | null;
  email_signature: string;
  daily_limit: number;
  status: 'Connected' | 'Disconnected' | 'Paused';
  last_error: string | null;
  /** 0-100 from bounces, warmup, placement tests, blocklists and DNS; null until first checked. */
  health_score: number | null;
  health_reasons: string[];
  /** Set when Kinetic paused the mailbox itself (bounce spike or blocklist). */
  paused_reason: string | null;
  last_synced_at: string | null;
  egress_route_id: number | null;
  egress_route: { id: number; name: string } | null;
  warmup_enabled: boolean;
  sent_last_24h: number;
  emails_sent_count: number;
  total_opened_count: number;
  unique_opened_count: number;
  bounced_count: number;
  total_leads_contacted_count: number;
  total_replied_count: number;
  unique_replied_count: number;
  interested_leads_count: number;
  unsubscribed_count: number;
  tags: Tag[];
  created_at: string;
  updated_at: string;
}

export interface WarmupStats {
  sent: number;
  sent_new: number;
  landed_inbox: number;
  landed_spam: number;
  received: number;
  rescued: number;
  replies_sent: number;
  health_score: number | null;
}

export interface EgressRoute { id: number; name: string; proxy_url: string | null; local_address: string | null; sender_count: number }

export interface DnsCheck { name: 'MX' | 'SPF' | 'DKIM' | 'DMARC'; status: 'pass' | 'warn' | 'fail'; value: string | null; advice: string }
export interface DomainReport { domain: string; checks: DnsCheck[]; ok: boolean }
