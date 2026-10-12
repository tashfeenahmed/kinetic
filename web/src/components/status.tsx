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
  interested: ['Interested', 'green'], not_interested: ['Not interested', 'gray'], unsubscribe: ['Unsub', 'yellow'], auto_reply: ['Auto reply', 'purple'],
  bounce: ['Bounce', 'red'], reply: ['Replied', 'blue'], other: ['Ignored', 'gray'],
};
const SCHEDULED: Record<string, [string, Tone]> = { scheduled: ['Scheduled', 'blue'], sending: ['Sending', 'blue'], sent: ['Sent', 'green'], failed: ['Failed', 'red'], cancelled: ['Cancelled', 'gray'] };

function make(map: Record<string, [string, Tone]>) {
  return function StatusBadge({ status, className }: { status: string; className?: string }) {
    const [label, tone] = map[status] ?? [status, 'gray'];
    return <Badge tone={tone} className={className}>{label}</Badge>;
  };
}

export const CampaignStatus = make(CAMPAIGN);
export const CampaignLeadStatus = make(CAMPAIGN_LEAD);
export const LeadStatus = make(LEAD);
export const SenderStatus = make(SENDER);
export const ReplyCategory = make(CATEGORY);
export const ScheduledStatus = make(SCHEDULED);

export const providerLabel = (p: string) => (p === 'google' ? 'Google' : p === 'microsoft' ? 'Microsoft' : 'Custom');
