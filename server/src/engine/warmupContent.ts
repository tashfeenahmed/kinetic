/**
 * Generates ordinary-looking business emails for warmup traffic. Varied structure and
 * vocabulary so messages do not share a fingerprint.
 */

const pick = <T>(arr: readonly T[], r: () => number) => arr[Math.floor(r() * arr.length)]!;
const shuffle = <T>(arr: T[], r: () => number) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
};

const SUBJECTS = [
  'Quick question about next week', 'Following up on our chat', 'Notes from today', 'Thoughts on the proposal',
  'Catching up', 'Agenda for Thursday', 'Small update', 'Re-scheduling our call', 'Can you take a look?',
  'Draft for review', 'Ideas for Q{n}', 'Lunch next week?', 'Checking in', 'Timeline update', 'Feedback request',
  'Budget numbers', 'Intro and next steps', 'One more thing', 'Project kickoff', 'Weekly sync notes',
  'The report you asked for', 'Meeting recap', 'Plan for the workshop', 'Question on the invoice', 'Hiring update',
  'Office move details', 'Slides for Monday', 'Revised schedule', 'Client call prep', 'Quick favour',
  'Training session', 'Next steps on the pilot', 'Vendor shortlist', 'Updated figures', 'Holiday cover',
  'Feedback on the draft', 'Approval needed', 'Trip planning', 'Website changes', 'Content calendar',
] as const;

const GREETINGS = ['Hi {name},', 'Hey {name},', 'Hello {name},', '{name},', 'Hi {name}!', 'Morning {name},', 'Good afternoon {name},'];
const OPENERS = [
  'Hope your week is going well.', 'Hope you had a good weekend.', 'Thanks again for the quick turnaround.',
  'Hope things are calm on your side.', 'Just picking this back up.', 'Thanks for sending that over.',
  'Good to catch you earlier.', 'Quick one from me today.', 'I was going through my notes from yesterday.',
];
const MIDDLES = [
  'I went through the numbers and they mostly line up with what we discussed.',
  'Could we move the call to later in the week? Thursday afternoon would suit me better.',
  'I have added a few comments to the document, mostly around the timeline.',
  'The team liked the second option, so I think we can go ahead with that one.',
  'Let me know if anything in the plan looks off to you.',
  'I spoke with finance and they are fine with the revised budget.',
  'We are still waiting on the final figures, but it should be ready by Friday.',
  'I think we should keep the scope small for the first phase and expand later.',
  'The client asked for a short summary before the meeting, so I will put one together.',
  'Happy to jump on a quick call if that is easier than going back and forth here.',
  'I booked the room for 2pm, so we should have plenty of time.',
  'There are a couple of open questions on the delivery dates that I would like to clear up.',
  'I shared the folder with you, everything should be in there now.',
  'The workshop went well overall and people asked for a follow-up session.',
  'We had a few issues with the export, but they are sorted now.',
  'I will send the updated version once I have gone through the last section.',
  'Would it help if I drafted the first version and you reviewed it?',
  'The supplier came back with a better quote than last time.',
  'It looks like most people are free on Tuesday morning.',
  'I moved the deadline back by a week to give everyone some breathing room.',
  'Could you double check the figures on the second tab when you get a minute?',
  'I am out on Friday, so anything urgent should go to the shared inbox.',
  'Overall I think we are in a good place, just need to tidy up a few details.',
  'Let us aim to have a decision by the end of the month.',
];
const CLOSERS = [
  'Let me know what you think.', 'Talk soon.', 'No rush on this.', 'Thanks in advance.', 'Speak tomorrow.',
  'Let me know if you need anything else.', 'Appreciate your help.', 'Have a good one.', 'Cheers for this.',
];
const SIGNOFFS = ['Best,', 'Thanks,', 'Cheers,', 'Regards,', 'Best regards,', 'Thanks again,', 'All the best,', '-'];

const REPLIES = [
  'Thanks for this, looks good to me.', 'Sounds good, Thursday works.', 'Got it, I will take a look this afternoon.',
  'Perfect, thanks for the update.', 'Makes sense. Let us go with that.', 'Thanks! I will get back to you by tomorrow.',
  'Great, appreciate you sending this over.', 'Noted, I will share it with the team.', 'That works for me.',
  'Thanks, I have added a couple of comments.', 'Agreed, let us keep it simple for now.', 'Sure, happy to help.',
  'Good catch, I will fix that.', 'Thanks for the heads up.', 'Yes, that time is fine.', 'Brilliant, thank you!',
];

const firstName = (name: string) => name.trim().split(/\s+/)[0] || 'there';

export function warmupEmail(fromName: string, toName: string, r: () => number = Math.random): { subject: string; text: string } {
  const subject = pick(SUBJECTS, r).replace('{n}', String(1 + Math.floor(r() * 4)));
  const parts: string[] = [];
  parts.push(pick(GREETINGS, r).replace('{name}', firstName(toName)));
  const body: string[] = [];
  if (r() < 0.7) body.push(pick(OPENERS, r));
  body.push(...shuffle([...MIDDLES], r).slice(0, 1 + Math.floor(r() * 3)));
  if (r() < 0.8) body.push(pick(CLOSERS, r));
  // Sometimes one paragraph, sometimes several.
  parts.push(r() < 0.5 ? body.join(' ') : body.join('\n\n'));
  parts.push(`${pick(SIGNOFFS, r)}\n${firstName(fromName)}`);
  return { subject, text: parts.join('\n\n') };
}

export function warmupReply(fromName: string, toName: string, r: () => number = Math.random): string {
  const lines = [pick(GREETINGS, r).replace('{name}', firstName(toName)), pick(REPLIES, r)];
  if (r() < 0.4) lines.push(pick(MIDDLES, r));
  lines.push(`${pick(SIGNOFFS, r)}\n${firstName(fromName)}`);
  return lines.join('\n\n');
}
