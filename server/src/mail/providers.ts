export interface ServerPreset {
  imap_server: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_server: string;
  smtp_port: number;
  smtp_secure: boolean;
}

/** Defaults filled in when a user picks a provider in the "Add sender" form. */
export const PRESETS: Record<'google' | 'microsoft', ServerPreset> = {
  google: { imap_server: 'imap.gmail.com', imap_port: 993, imap_secure: true, smtp_server: 'smtp.gmail.com', smtp_port: 465, smtp_secure: true },
  microsoft: { imap_server: 'outlook.office365.com', imap_port: 993, imap_secure: true, smtp_server: 'smtp.office365.com', smtp_port: 587, smtp_secure: false },
};

export function guessProvider(host: string | null | undefined): 'google' | 'microsoft' | 'custom' {
  const h = (host ?? '').toLowerCase();
  if (h.includes('gmail') || h.includes('google')) return 'google';
  if (h.includes('office365') || h.includes('outlook') || h.includes('microsoft')) return 'microsoft';
  return 'custom';
}

/** Common special-use folder names when the server does not advertise \Junk. */
export const SPAM_FOLDER_NAMES = ['[Gmail]/Spam', 'Junk', 'Junk Email', 'Junk E-mail', 'Spam', 'Bulk Mail', 'INBOX.Junk', 'INBOX.Spam'];
