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
  { key: 'AI_MODEL', icon: 'sparkles', label: 'Default model', group: 'AI research', priority: 'optional', unlocks: 'Model used when a column doesn’t pick one', cost: '—', secret: false, placeholder: 'anthropic/claude-haiku-5.5' },
  { key: 'AI_BASE_URL', domain: 'ollama.com', label: 'AI base URL (local models)', group: 'AI research', priority: 'optional', unlocks: 'Any OpenAI-compatible server instead of OpenRouter — e.g. Ollama or LM Studio, fully free/offline', cost: 'Free (your hardware)', link: 'https://ollama.com', secret: false, placeholder: 'http://localhost:11434/v1' },

  // Search
  { key: 'SERPER_API_KEY', domain: 'serper.dev', label: 'Serper (Google results)', group: 'Web search', priority: 'start', unlocks: 'Agent web search, LinkedIn URL and company-domain lookups', cost: '2,500 free, then ~$1 / 1k', link: 'https://serper.dev', free: 'Your own SearXNG instance (public ones block API use), else DuckDuckGo — free but unreliable' },
  { key: 'SEARXNG_URL', domain: 'searxng.org', label: 'SearXNG instance', group: 'Web search', priority: 'optional', unlocks: 'Free open-source metasearch (github.com/searxng/searxng) — run it locally with Docker for unlimited free search', cost: 'Free', link: 'https://docs.searxng.org/admin/installation-docker.html', secret: false, placeholder: 'http://localhost:8888' },
  { key: 'BRAVE_API_KEY', domain: 'brave.com', label: 'Brave Search', group: 'Web search', priority: 'optional', unlocks: 'Alternative search API', cost: '$5 credit/mo, then $5 / 1k', link: 'https://api-dashboard.search.brave.com' },
  { key: 'TAVILY_API_KEY', domain: 'tavily.com', label: 'Tavily', group: 'Web search', priority: 'optional', unlocks: 'Alternative search API built for agents', cost: '1,000 free/mo', link: 'https://tavily.com' },
  { key: 'EXA_API_KEY', domain: 'exa.ai', label: 'Exa', group: 'Web search', priority: 'optional', unlocks: 'Neural search API', cost: '$10 free credit', link: 'https://exa.ai' },
  { key: 'JINA_API_KEY', domain: 'jina.ai', label: 'Jina Reader', group: 'Web search', priority: 'optional', unlocks: 'Renders JavaScript-heavy pages for the agent', cost: 'Free tier', link: 'https://jina.ai/reader', free: 'Plain page fetch (built in)' },

  // Alerts / compliance
  { key: 'SLACK_WEBHOOK_URL', domain: 'slack.com', label: 'Slack incoming webhook', group: 'Alerts', priority: 'start', unlocks: 'Signal alerts and Slack action columns', cost: 'Free', link: 'https://api.slack.com/messaging/webhooks', free: 'Webhook action to any URL (n8n, Discord, etc.)' },
  { key: 'SLACK_BOT_TOKEN', domain: 'slack.com', label: 'Slack bot token', group: 'Alerts', priority: 'optional', unlocks: 'Post to a channel chosen per column (chat:write scope)', cost: 'Free', link: 'https://api.slack.com/apps' },
  { key: 'SEC_USER_AGENT', domain: 'sec.gov', label: 'SEC User-Agent', group: 'Alerts', priority: 'start', unlocks: 'Required by SEC for funding (Form D) and 8-K signals — not a key, just “Your Name you@email.com”', cost: 'Free', secret: false, placeholder: 'Jane Doe jane@example.com' },

  // Email
  { key: 'SMTP_HELO', icon: 'mail', label: 'SMTP HELO domain', group: 'Email finding & verification', priority: 'recommended', unlocks: 'Hostname the free SMTP verifier introduces itself as. A domain you own improves acceptance', cost: 'Free', secret: false, placeholder: 'mail.yourdomain.com' },
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

  // Signals
  { key: 'GITHUB_TOKEN', domain: 'github.com', label: 'GitHub token', group: 'Signals', priority: 'recommended', unlocks: 'Free key that powers the free email finder (commit patterns), GitHub org people source and GitHub signal — raises limits from 60 to 5,000 requests/hour. No scopes needed', cost: 'Free', link: 'https://github.com/settings/tokens' },
  { key: 'COMPANIES_HOUSE_API_KEY', domain: 'companieshouse.gov.uk', label: 'UK Companies House', group: 'Signals', priority: 'optional', unlocks: 'UK filings signal', cost: 'Free', link: 'https://developer.company-information.service.gov.uk' },
  { key: 'CERTSPOTTER_API_KEY', domain: 'sslmate.com', label: 'Cert Spotter', group: 'Signals', priority: 'optional', unlocks: 'More new-subdomain lookups than the free ~10/hour', cost: 'Paid tiers', link: 'https://sslmate.com/certspotter/api', free: 'Free tier + crt.sh fallback (built in)' },

  // CRM
  { key: 'HUBSPOT_TOKEN', domain: 'hubspot.com', label: 'HubSpot private app token', group: 'CRM', priority: 'crm', unlocks: 'Import contacts/companies; upsert actions', cost: 'Free with HubSpot', link: 'https://developers.hubspot.com/docs/api/private-apps' },
  { key: 'SALESFORCE_DOMAIN', domain: 'salesforce.com', label: 'Salesforce My Domain', group: 'CRM', priority: 'crm', unlocks: 'Salesforce upsert action', cost: 'Needs Salesforce', secret: false, placeholder: 'acme.my.salesforce.com' },
  { key: 'SALESFORCE_CLIENT_ID', domain: 'salesforce.com', label: 'Salesforce consumer key', group: 'CRM', priority: 'crm', unlocks: 'Client-credentials connected app', cost: '—' },
  { key: 'SALESFORCE_CLIENT_SECRET', domain: 'salesforce.com', label: 'Salesforce consumer secret', group: 'CRM', priority: 'crm', unlocks: 'Client-credentials connected app', cost: '—' },
];
