import { Badge, type Tone } from './ui.tsx';

/** Consistent labels and colours for every status in the app. */
const CAMPAIGN: Record<string, [string, Tone]> = {
  draft: ['Draft', 'gray'], active: ['Active', 'green'], paused: ['Paused', 'yellow'], completed: ['Completed', 'blue'], archived: ['Archived', 'gray'],
};
const CAMPAIGN_LEAD: Record<string, [string, Tone]> = {
  pending: ['Not started', 'gray'], in_sequence: ['In sequence', 'blue'], completed: ['Completed', 'purple'], replied: ['Replied', 'green'],
  interested: ['Interested', 'green'], unsubscribed: ['Unsubscribed', 'orange'], bounced: ['Bounced', 'red'], stopped: ['Stopped', 'gray'], paused: ['Sending Paused', 'yellow'],
};
const LEAD: Record<string, [string, Tone]> = {
  verified: ['Verified', 'green'], unverified: ['Unverified', 'gray'], unknown: ['Unknown', 'gray'], unsubscribed: ['Unsubscribed', 'orange'],
  risky: ['Risky', 'yellow'], inactive: ['Inactive', 'gray'], bounced: ['Bounced', 'red'],
};
const SENDER: Record<string, [string, Tone]> = { Connected: ['Connected', 'green'], Disconnected: ['Disconnected', 'red'], Paused: ['Paused', 'yellow'] };
const CATEGORY: Record<string, [string, Tone]> = {
  interested: ['Interested', 'green'], not_interested: ['Not interested', 'gray'], unsubscribe: ['Unsub', 'yellow'], auto_reply: ['Automated', 'purple'],
  bounce: ['Bounce', 'red'], reply: ['Replied', 'blue'], other: ['Ignored', 'gray'],
  meeting_request: ['Meeting', 'green'], more_info: ['Question', 'blue'], objection: ['Objection', 'orange'], referral: ['Referral', 'purple'],
  wrong_person: ['Wrong person', 'gray'], out_of_office: ['Out of office', 'purple'],
};
/** Reply labels in display order, for filters and the re-label menu. */
export const REPLY_LABELS: { id: string; label: string }[] = [
  'interested', 'meeting_request', 'more_info', 'objection', 'not_interested', 'referral', 'wrong_person', 'out_of_office', 'auto_reply', 'unsubscribe', 'reply', 'bounce',
].map((id) => ({ id, label: CATEGORY[id]![0] }));
const SCHEDULED: Record<string, [string, Tone]> = { scheduled: ['Scheduled', 'blue'], sending: ['Sending', 'blue'], sent: ['Sent', 'green'], failed: ['Failed', 'red'], cancelled: ['Cancelled', 'gray'] };

/** Hover notes for labels that aren't self-explanatory. */
const CATEGORY_HINTS: Record<string, string> = {
  auto_reply: 'Sent by a machine, not a person (sign-up confirmations, security codes, auto-responders). Not counted as a reply and never marked interested.',
  other: 'Matched one of your ignore phrases, so it is not counted as a reply.',
};

function make(map: Record<string, [string, Tone]>, hints: Record<string, string> = {}) {
  return function StatusBadge({ status, className }: { status: string; className?: string }) {
    const [label, tone] = map[status] ?? [status, 'gray'];
    const badge = <Badge tone={tone} className={className}>{label}</Badge>;
    return hints[status] ? <span title={hints[status]}>{badge}</span> : badge;
  };
}

export const CampaignStatus = make(CAMPAIGN);
export const CampaignLeadStatus = make(CAMPAIGN_LEAD);
export const LeadStatus = make(LEAD);
export const SenderStatus = make(SENDER);
export const ReplyCategory = make(CATEGORY, CATEGORY_HINTS);
export const ScheduledStatus = make(SCHEDULED);

export const providerLabel = (p: string) => (p === 'google' ? 'Google' : p === 'microsoft' ? 'Microsoft' : 'Custom');
