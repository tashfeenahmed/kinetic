/**
 * Everything the Settings page shows about each key: why you'd want it, what it
 * costs, where to get it, and which free built-in alternative covers it without one.
 */
import type { SettingKey } from './settings.ts';

export type Priority = 'start' | 'recommended' | 'optional' | 'crm';

export interface SettingMeta {
  key: SettingKey;
  label: string;
  group: string;
  priority: Priority;
  unlocks: string;
  cost: string;
  link?: string;
  free?: string; // built-in free alternative used when this isn't set
  secret?: boolean; // default true
  placeholder?: string;
  /** Brand domain for the logo; omitted keys get a generic line icon. */
  domain?: string;
  icon?: string;
}

export const SETTINGS_META: SettingMeta[] = [
  // AI
  { key: 'OPENROUTER_API_KEY', domain: 'openrouter.ai', label: 'OpenRouter', group: 'AI research', priority: 'start', unlocks: 'AI research columns (Haiku 5.5, Gemini, 300+ models)', cost: 'Pay per use — Haiku 5.5 $0.10/$0.50 per M tokens; ~15 models are free', link: 'https://openrouter.ai/settings/keys', free: 'Pick a FREE model in the column (still needs this key; 50 free requests/day, 1,000/day after a one-time $10 top-up), or run a local Ollama model via AI base URL' },
  { key: 'AI_MODEL', icon: 'brain', label: 'Default model', group: 'AI research', priority: 'optional', unlocks: 'Model used when a column doesn’t pick one', cost: '—', secret: false, placeholder: 'anthropic/claude-haiku-5.5' },
  { key: 'AI_BASE_URL', domain: 'ollama.com', label: 'AI base URL (local models)', group: 'AI research', priority: 'optional', unlocks: 'Any OpenAI-compatible server instead of OpenRouter — e.g. Ollama or LM Studio, fully free/offline', cost: 'Free (your hardware)', link: 'https://ollama.com', secret: false, placeholder: 'http://localhost:11434/v1' },
  { key: 'AGENT_MODEL', icon: 'brain', label: 'Kinetic Agent model', group: 'AI research', priority: 'optional', unlocks: 'Model the Agent tab chats with (falls back to the default model). Strong tool-callers work best', cost: '—', secret: false, placeholder: 'anthropic/claude-haiku-5.5' },

  // Search
  { key: 'SERPER_API_KEY', domain: 'serper.dev', label: 'Serper (Google results)', group: 'Web search', priority: 'start', unlocks: 'Agent web search, LinkedIn URL and company-domain lookups', cost: '2,500 free, then ~$1 / 1k', link: 'https://serper.dev', free: 'Your own SearXNG instance (public ones block API use), else DuckDuckGo — free but unreliable. Used as a fallback when SearXNG fails' },
  { key: 'SEARXNG_URL', domain: 'searxng.org', label: 'SearXNG instance', group: 'Web search', priority: 'optional', unlocks: 'Free open-source metasearch (github.com/searxng/searxng) — run it locally with Docker for unlimited free search', cost: 'Free', link: 'https://docs.searxng.org/admin/installation-docker.html', secret: false, placeholder: 'http://localhost:8888' },
  { key: 'SEARCH_ENGINE', icon: 'search', label: 'Preferred search engine', group: 'Web search', priority: 'optional', unlocks: 'Which engine is tried first: searxng, serper, brave, tavily, exa or duckduckgo. Default: your SearXNG first, then the paid APIs, then DuckDuckGo; a failed or empty search falls through to the next', cost: '—', secret: false, placeholder: 'searxng' },
  { key: 'SCRAPE_PROXY', domain: 'cloudflare.com', label: 'Lookup proxy', group: 'Web search', priority: 'optional', unlocks: 'Website, search and data lookups leave through this proxy so sites block them less (local addresses like your SearXNG skip it). Email sending and sign-ins never use it', cost: 'Free with Cloudflare WARP on this machine (http://127.0.0.1:40000)', link: 'https://developers.cloudflare.com/warp-client/', secret: false, placeholder: 'http://127.0.0.1:40000' },
  { key: 'BRAVE_API_KEY', domain: 'brave.com', label: 'Brave Search', group: 'Web search', priority: 'optional', unlocks: 'Alternative search API', cost: '$5 credit/mo, then $5 / 1k', link: 'https://api-dashboard.search.brave.com' },
  { key: 'TAVILY_API_KEY', domain: 'tavily.com', label: 'Tavily', group: 'Web search', priority: 'optional', unlocks: 'Alternative search API built for agents', cost: '1,000 free/mo', link: 'https://tavily.com' },
  { key: 'EXA_API_KEY', domain: 'exa.ai', label: 'Exa', group: 'Web search', priority: 'optional', unlocks: 'Neural search API', cost: '$10 free credit', link: 'https://exa.ai' },
  { key: 'JINA_API_KEY', domain: 'jina.ai', label: 'Jina Reader', group: 'Web search', priority: 'optional', unlocks: 'Renders JavaScript-heavy pages for the agent', cost: 'Free tier', link: 'https://jina.ai/reader', free: 'Plain page fetch (built in)' },

  // Email infrastructure
  { key: 'CLOUDFLARE_API_TOKEN', domain: 'cloudflare.com', label: 'Cloudflare', group: 'Email infrastructure', priority: 'recommended', unlocks: 'One-click sending-domain setup (Add domain on the Sender Emails page): MX, SPF, DKIM, DMARC, tracking and redirects written to your Cloudflare DNS. Token permissions: Zone → DNS → Edit and Zone → Zone → Read (add Zone → Zone → Edit + Account Settings → Read to add new domains, Zone → Dynamic Redirect → Edit for redirects)', cost: 'Free', link: 'https://dash.cloudflare.com/profile/api-tokens', free: 'Copy the records from the domain’s DNS plan into any DNS provider by hand' },

  // Alerts / compliance
  { key: 'SLACK_WEBHOOK_URL', domain: 'slack.com', label: 'Slack incoming webhook', group: 'Alerts', priority: 'start', unlocks: 'Signal alerts and Slack action columns', cost: 'Free', link: 'https://api.slack.com/messaging/webhooks', free: 'Webhook action to any URL (n8n, Discord, etc.)' },
  { key: 'SLACK_BOT_TOKEN', domain: 'slack.com', label: 'Slack bot token', group: 'Alerts', priority: 'optional', unlocks: 'Post to a channel chosen per column (chat:write scope)', cost: 'Free', link: 'https://api.slack.com/apps' },
  { key: 'SEC_USER_AGENT', domain: 'sec.gov', label: 'SEC User-Agent', group: 'Alerts', priority: 'start', unlocks: 'Required by SEC for funding (Form D) and 8-K signals — not a key, just “Your Name you@email.com”', cost: 'Free', secret: false, placeholder: 'Jane Doe jane@example.com' },

  // Email
  { key: 'SMTP_HELO', icon: 'mail', label: 'SMTP HELO domain', group: 'Email finding & verification', priority: 'recommended', unlocks: 'Hostname(s) the free SMTP verifier introduces itself as. Use spare/burner domains, never your sending domain. Comma-separate several to rotate (each mail server keeps the same one for 30 min)', cost: 'Free', secret: false, placeholder: 'mail.burner1.com, mail.burner2.com' },
  { key: 'SMTP_MAIL_FROM', icon: 'mail', label: 'SMTP verifier MAIL FROM', group: 'Email finding & verification', priority: 'optional', unlocks: 'Envelope sender for SMTP checks; {helo_domain} becomes the HELO name in use. Leave empty for the null sender <> (recommended). The domain’s SPF must not fail for this server', cost: 'Free', secret: false, placeholder: 'check@{helo_domain}' },
  { key: 'MILLIONVERIFIER_API_KEY', domain: 'millionverifier.com', label: 'MillionVerifier', group: 'Email finding & verification', priority: 'recommended', unlocks: 'Paid verification; settles catch-all/unknown results the free SMTP check can’t', cost: '~$89 / 50k checks', link: 'https://app.millionverifier.com/api', free: 'SMTP mailbox check (built in, needs outbound port 25)' },
  { key: 'HUNTER_API_KEY', domain: 'hunter.io', label: 'Hunter', group: 'Email finding & verification', priority: 'recommended', unlocks: 'Email finder + company info', cost: '50 free/mo', link: 'https://hunter.io/api-keys', free: 'Free finder: learns the company pattern from its website + GitHub commits, then SMTP-checks' },
  { key: 'ICYPEAS_API_KEY', domain: 'icypeas.com', label: 'Icypeas', group: 'Email finding & verification', priority: 'recommended', unlocks: 'Email finder (~$0.01 per found email, credits never expire)', cost: 'Pay as you go', link: 'https://www.icypeas.com', free: 'Free finder (built in)' },
  { key: 'FINDYMAIL_API_KEY', domain: 'findymail.com', label: 'Findymail', group: 'Email finding & verification', priority: 'optional', unlocks: 'Verified-only email finder; phone from LinkedIn', cost: 'Paid', link: 'https://app.findymail.com', free: 'Free finder (built in)' },
  { key: 'PROSPEO_API_KEY', domain: 'prospeo.io', label: 'Prospeo', group: 'Email finding & verification', priority: 'optional', unlocks: 'Email + mobile finder', cost: 'Paid', link: 'https://app.prospeo.io/api', free: 'Free finder (built in)' },
  { key: 'LEADMAGIC_API_KEY', domain: 'leadmagic.io', label: 'LeadMagic', group: 'Email finding & verification', priority: 'optional', unlocks: 'Email ($0.02) and mobile (~$0.10) finder', cost: 'Paid', link: 'https://app.leadmagic.io', free: 'No free source for mobile numbers' },
  { key: 'ZEROBOUNCE_API_KEY', domain: 'zerobounce.net', label: 'ZeroBounce', group: 'Email finding & verification', priority: 'optional', unlocks: 'Alternative verifier', cost: '~$0.008 / check', link: 'https://www.zerobounce.net/members/apikey', free: 'SMTP mailbox check (built in)' },

  // Company & people data
  { key: 'PDL_API_KEY', domain: 'peopledatalabs.com', label: 'People Data Labs', group: 'Company & people data', priority: 'recommended', unlocks: 'Person/company enrichment, LinkedIn URLs, job-change checks', cost: '100 free/mo (contact fields hidden)', link: 'https://dashboard.peopledatalabs.com', free: 'Company: YC directory + Wikidata + website scrape (built in)' },
  { key: 'APOLLO_API_KEY', domain: 'apollo.io', label: 'Apollo', group: 'Company & people data', priority: 'optional', unlocks: 'People/company search to fill tables; enrichment', cost: 'Free tier; search needs a master key', link: 'https://app.apollo.io/#/settings/integrations/api', free: 'YC company search source + Wikidata (built in)' },
  { key: 'GOOGLE_MAPS_API_KEY', domain: 'maps.google.com', label: 'Google Maps (Places API)', group: 'Company & people data', priority: 'optional', unlocks: 'Local business search (Find prospects → Local businesses): name, category, address, phone, website, rating and reviews. Enable “Places API (New)” on the key', cost: 'Google gives free monthly usage on every Maps API SKU (thousands of Text Search requests a month), then pay per 1,000 — Kinetic asks only for the fields it needs to keep cost low', link: 'https://console.cloud.google.com/google/maps-apis/credentials', free: 'OpenStreetMap (Nominatim + Overpass) — free, no key; fewer phones/websites and no ratings' },

  // Signals
  { key: 'GITHUB_TOKEN', domain: 'github.com', label: 'GitHub token', group: 'Signals', priority: 'recommended', unlocks: 'Free key that powers the free email finder (commit patterns), GitHub org people source and GitHub signal — raises limits from 60 to 5,000 requests/hour. No scopes needed', cost: 'Free', link: 'https://github.com/settings/tokens' },
  { key: 'COMPANIES_HOUSE_API_KEY', domain: 'companieshouse.gov.uk', label: 'UK Companies House', group: 'Signals', priority: 'optional', unlocks: 'UK filings signal', cost: 'Free', link: 'https://developer.company-information.service.gov.uk' },
  { key: 'CERTSPOTTER_API_KEY', domain: 'sslmate.com', label: 'Cert Spotter', group: 'Signals', priority: 'optional', unlocks: 'More new-subdomain lookups than the free ~10/hour', cost: 'Paid tiers', link: 'https://sslmate.com/certspotter/api', free: 'Free tier + crt.sh fallback (built in)' },

  // CRM
  { key: 'HUBSPOT_TOKEN', domain: 'hubspot.com', label: 'HubSpot private app token', group: 'CRM', priority: 'crm', unlocks: 'Import contacts/companies; upsert actions', cost: 'Free with HubSpot', link: 'https://developers.hubspot.com/docs/api/private-apps' },
  { key: 'SALESFORCE_DOMAIN', domain: 'salesforce.com', label: 'Salesforce My Domain', group: 'CRM', priority: 'crm', unlocks: 'Salesforce upsert action', cost: 'Needs Salesforce', secret: false, placeholder: 'acme.my.salesforce.com' },
  { key: 'SALESFORCE_CLIENT_ID', domain: 'salesforce.com', label: 'Salesforce consumer key', group: 'CRM', priority: 'crm', unlocks: 'Client-credentials connected app', cost: '—' },
  { key: 'SALESFORCE_CLIENT_SECRET', domain: 'salesforce.com', label: 'Salesforce consumer secret', group: 'CRM', priority: 'crm', unlocks: 'Client-credentials connected app', cost: '—' },

  // Website visitors
  { key: 'TRACKING_PUBLIC_URL', icon: 'link', label: 'Tracking public URL', group: 'Website visitors', priority: 'recommended', unlocks: 'Public https address of this Kinetic (e.g. a Cloudflare Tunnel) used by the website visitor snippet and collect endpoint. Needed when PUBLIC_URL is localhost or a LAN address', cost: 'Free', link: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/', secret: false, placeholder: 'https://kinetic.example.com', free: 'Falls back to PUBLIC_URL' },
  { key: 'IPINFO_TOKEN', domain: 'ipinfo.io', label: 'IPinfo Lite', group: 'Website visitors', priority: 'optional', unlocks: 'Faster, more accurate IP → company (ASN, organisation domain) for website visitors', cost: 'Free (Lite, unlimited)', link: 'https://ipinfo.io/signup', free: 'Reverse DNS + RDAP from the regional internet registries (built in)' },
];
