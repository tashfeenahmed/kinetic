/**
 * OAuth2 for Google and Microsoft mailboxes (IMAP/SMTP via XOAUTH2).
 *
 * For personal use you register your own app:
 *  - Google: Cloud Console -> OAuth client (Web). Unverified apps work for up to 100 users.
 *  - Microsoft: Entra ID -> App registration, then grant admin consent in your own tenant(s).
 * Client IDs/secrets are stored in the settings table (Settings -> Integrations).
 */
export type OAuthProvider = 'google' | 'microsoft';

export interface OAuthAppConfig {
  clientId: string;
  clientSecret: string;
  tenant?: string; // microsoft only, default "common"
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}

const GOOGLE_SCOPES = ['https://mail.google.com/', 'openid', 'email', 'profile'];
const MS_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access', 'openid', 'email', 'profile',
];

/** Endpoints are overridable so tests can point at a local fake. */
export const endpoints = {
  google: { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' },
  microsoft: (tenant = 'common') => ({
    auth: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
  }),
  override: null as null | { auth: string; token: string },
};

function ep(provider: OAuthProvider, cfg: OAuthAppConfig) {
  if (endpoints.override) return endpoints.override;
  return provider === 'google' ? endpoints.google : endpoints.microsoft(cfg.tenant);
}

export function authorizeUrl(provider: OAuthProvider, cfg: OAuthAppConfig, redirectUri: string, state: string, opts: { adminConsent?: boolean; loginHint?: string } = {}): string {
  const u = new URL(ep(provider, cfg).auth);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  u.searchParams.set('scope', (provider === 'google' ? GOOGLE_SCOPES : MS_SCOPES).join(' '));
  // Reconnecting: pre-fill the account so the right mailbox signs in.
  if (opts.loginHint) u.searchParams.set('login_hint', opts.loginHint);
  if (provider === 'google') {
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
  } else {
    u.searchParams.set('prompt', opts.adminConsent ? 'admin_consent' : 'select_account');
  }
  return u.toString();
}

async function tokenRequest(provider: OAuthProvider, cfg: OAuthAppConfig, body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(ep(provider, cfg).token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !json.access_token) {
    throw new Error(`OAuth token error (${res.status}): ${json.error_description ?? json.error ?? 'unknown error'}`);
  }
  return json as TokenSet;
}

export function exchangeCode(provider: OAuthProvider, cfg: OAuthAppConfig, code: string, redirectUri: string) {
  return tokenRequest(provider, cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
}

export function refreshAccessToken(provider: OAuthProvider, cfg: OAuthAppConfig, refreshToken: string) {
  const extra: Record<string, string> = provider === 'microsoft' ? { scope: MS_SCOPES.join(' ') } : {};
  return tokenRequest(provider, cfg, { grant_type: 'refresh_token', refresh_token: refreshToken, ...extra });
}

/** Reads the email/name claims from an id_token without verifying (it came straight from the token endpoint over TLS). */
export function idTokenClaims(idToken?: string): { email?: string; name?: string; preferred_username?: string } {
  if (!idToken) return {};
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}
