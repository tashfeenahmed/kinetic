# kineticsand: research on signals and data sources

*Compiled 2026-10-12 for a single-user, no-billing, budget-sensitive Clay clone.*

**How to read the confidence tags**

- **[V]** I checked this myself on 2026-10-12, either against the vendor's own page or with a live `curl` call.
- **[3P]** The figure comes from third-party or aggregator sites. Sources often disagree, so confirm it before you spend money.
- **[?]** This is uncertain or unverified.

Vendor prices change often. Treat every number here as a starting point and re-check it at signup.

---

## 0. TL;DR

| Need | Free first | Cheap paid next |
|---|---|---|
| Hiring signal | Greenhouse, Lever, Ashby and SmartRecruiters public JSON **[V]** | TheirStack: 200 free API credits/mo, then $59/mo **[3P]** |
| Funding | SEC EDGAR Form D (free, no key) **[V]** and Google News RSS **[V]** | Fundable or Crunchbase (expensive) |
| News | Google News RSS **[V]**; GDELT DOC API (1 request per 5s) **[V]** | — |
| Tech stack | Self-fingerprinting with `wappalyzergo`/webappanalyzer, DNS TXT/MX and CT logs | BuiltWith ($295/mo+) or Wappalyzer ($250/mo+) **[3P]**; not worth it for one user |
| Job changes | Re-enrich periodically and diff (title/company) | LeadMagic Job Change Detector at 3 credits (about $0.06) **[V]** |
| Work email | Hunter (50 free/mo) **[V]** | Icypeas ($0.019 to $0.005 per credit, credits never expire) **[V]**, then LeadMagic or Findymail |
| Mobile | — | FullEnrich or BetterContact waterfall (10 credits ≈ $0.49 to $0.55 per found mobile) **[V]** |
| Firmographics | Clearbit autocomplete (name to domain) **[V]**, SEC, Companies House, Wikidata, PDL free 100/mo **[V]** | PDL Pro ($98 for 350 records) **[V]**, Icypeas company scraper (0.5 credit) **[V]** |
| Verification | Reoon (600 free/mo) **[3P]**, MillionVerifier (100 free) **[V]** | MillionVerifier ($89 per 50k) **[V]** or Reoon (about $12 per 10k) **[3P]** |
| Agent web search | Serper (2,500 free) **[V]**; Exa ($10 free credit/mo) **[V]**; Tavily (1,000 free credits/mo) **[V]**; Jina Reader (20 RPM with no key) **[V]** | Serper (about $1 per 1k); Brave ($5 per 1k) **[V]** |
| LLM | `anthropic/claude-haiku-5.5` at $0.10/$0.50 per M tokens **[V]** | OpenRouter web plugin with Exa: $0.007/request **[V]** |

**Dead or changed (check before you integrate)**

- **Proxycurl** shut down in July 2025 after LinkedIn sued. The case ended in a permanent injunction, and the team pivoted to NinjaPear.
- **Clearbit Logo API** was sunset on 8 December 2025. The other free Clearbit tools ended 30 April 2025. Autocomplete still answers (see §2.6).
- **Brave Search** ended its 5k/mo free plan for new users in about February 2026. It now gives $5 of free credit per month.
- **OpenCorporates** has no meaningful free API. Self-serve plans start at about £2,250/yr.
- **Crunchbase** has no free funding API.
- **Wappalyzer** went closed-source in 2023. Use community forks.

---

## 1. SIGNALS

### 1.1 Hiring (job postings): the best free signal

Most ATS vendors expose public, unauthenticated JSON job boards. The approach is to resolve a company's ATS once, then poll it daily, diff the job IDs, and emit a signal for "new role matching /sales|revops|data engineer/".

To discover which ATS a company uses, fetch `{domain}/careers` (use Jina Reader to render it) and grep the HTML for links to `boards.greenhouse.io`, `jobs.lever.co`, `jobs.ashbyhq.com`, `apply.workable.com`, `jobs.smartrecruiters.com`, `{x}.recruitee.com`, `{x}.jobs.personio.de/.com`, `{x}.bamboohr.com/careers` or `myworkdayjobs.com`.

| ATS | Endpoint (GET, no auth) | Status | Notes |
|---|---|---|---|
| **Greenhouse** | `https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | **[V]** 200 (Anthropic: 645 jobs) | Fields: `id, title, location, updated_at, first_published, absolute_url`. `/departments` and `/offices` are also available. No documented rate limit; be polite (≤1 rps). |
| **Lever** | `https://api.lever.co/v0/postings/{company}?mode=json` (supports `&limit=`, `&skip=`) | **[V]** 200 | Fields: `id, text, categories{team,location,commitment}, createdAt, hostedUrl, workplaceType`. EU tenants use `api.eu.lever.co`. |
| **Ashby** | `https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` | **[V]** 200 | Responses can be large (OpenAI's was 14 MB with descriptions). Includes comp bands, which is a nice "budget" signal. |
| **SmartRecruiters** | `https://api.smartrecruiters.com/v1/companies/{companyId}/postings?limit=100&offset=0` | **[V]** 200 | The company ID is case-sensitive. Returns empty `content` if the ID is wrong (no 404). |
| **Workable** | `https://apply.workable.com/api/v3/accounts/{sub}/jobs` (POST `{"query":""}`) and the older `https://www.workable.com/api/accounts/{sub}?details=true` | **[?]** Test returned 404/302 for a dummy account | Verify against a real subdomain. The widget endpoint `apply.workable.com/api/v1/widget/accounts/{sub}` is also referenced in community code. |
| **Recruitee** | `https://{company}.recruitee.com/api/offers/` | **[?]** | Public "careers site" API. |
| **Personio** | `https://{company}.jobs.personio.de/xml` | **[?]** | XML feed. |
| **Workday** | `POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` body `{"limit":20,"offset":0,"searchText":""}` | **[?]** | Undocumented internal endpoint. Works widely, but it's ToS-grey. |

**Aggregators (paid, cross-company search)**

| Source | Free | Paid | Notes |
|---|---|---|---|
| **TheirStack** | 200 API credits/mo (1 credit per job, 3 per company); 50 app company credits | API from $59/mo for 1,500 credits | **[3P]** from its pricing page. Also sells a technographics dataset inferred from job posts (32k+ technologies). |
| Coresignal jobs | Trial (terms conflict: 14-day 200/400 credits vs 7-day 2,000) | From $49/mo | **[3P]** |
| LeadMagic "Jobs Finder" | — | 1 credit per job | **[V]** |
| Google Jobs via SerpAPI | 250 searches/mo | $25/mo for 1k | **[V]** |

The reliability of the direct ATS route is high, since it's the source of truth. Legal risk is low because these are public, intended-for-syndication feeds.

### 1.2 Funding rounds

| Source | Endpoint | Cost | Notes |
|---|---|---|---|
| **SEC Form D (EDGAR)** | Latest filings as Atom: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=D&count=100&output=atom`. Full-text search (unofficial JSON behind efts): `https://efts.sec.gov/LATEST/search-index?forms=D&dateRange=custom&startdt=2026-10-01&enddt=2026-10-10` **[V 200]**. Per company: `https://data.sec.gov/submissions/CIK##########.json` **[V]**. Quarterly bulk: sec.gov "Form D data sets". | Free, no key **[V]** | SEC fair-access rule: ≤10 requests/s and a descriptive `User-Agent: kineticsand you@example.com`, or you get blocked. Form D captures US private raises (amount, date, related persons, i.e. founders/execs). It often appears before press coverage. It misses non-US raises and some SAFEs. |
| **Google News RSS** | `https://news.google.com/rss/search?q=%22{company}%22+(raises+OR+funding+OR+%22Series+A%22)&hl=en-US&gl=US&ceid=US:en` | Free **[V 200]** | Not an official API. Links are Google redirect URLs. Rate-limit yourself (a few requests per minute). |
| TechCrunch venture RSS | `https://techcrunch.com/category/venture/feed/` | Free | Use an LLM to parse "X raises $Y Series Z led by W". |
| Crunchbase API | Basic tier (org lookup/autocomplete only) [?] | Funding data requires a contract; median about $20k/yr [3P] | Not worth it. |
| Fundable, Multiples, Dealroom, Harmonic, Tracxn | — | Quote-based; Fundable is "self-serve" [3P] | Optional. |
| LeadMagic "Company Funding" | — | 4 credits ≈ $0.08 | **[V]** Cheapest on-demand lookup. |
| PDL company enrich | 100 free/mo | — | Includes `total_funding_raised`, `latest_funding_stage`. |

### 1.3 News mentions

| Source | Endpoint | Limits | Notes |
|---|---|---|---|
| **Google News RSS** | as above; `when:7d` works in `q` | Unofficial; throttle | Best free recall. |
| **GDELT DOC 2.0** | `https://api.gdeltproject.org/api/v2/doc/doc?query=%22acme%22&mode=artlist&format=json&maxrecords=75&timespan=7d` | **1 request per 5 s [V]**, which it enforces with a text error | Free, global, multilingual. Free bulk data is on BigQuery. |
| Hacker News (Algolia) | `https://hn.algolia.com/api/v1/search_by_date?query=acme&tags=story` | Generous | Good for dev-tool launches. |
| Reddit | `https://www.reddit.com/search.json?q=acme` | OAuth required for any real volume | The ToS restricts commercial use. |
| Bing News API | — | **Retired August 2025** | Don't use. |

### 1.4 Job changes and promotions

LinkedIn is the source of truth and is legally hostile (see §1.10). The cheapest legitimate approaches, in order:

1. **Periodic re-enrichment diff.** Store `(person, company_domain, title)`. Every 30 to 90 days, re-run a cheap profile lookup (Icypeas "Profile Scraper" at 1.5 credits ≈ $0.01 to $0.03, or a PDL free credit) and diff the result. If the company changed, that's a job change. If the title changed at the same company, that's a promotion.
2. **Email bounce or verification flip.** Re-verify stored work emails every 60 days with MillionVerifier (≈ $0.0018 each). A newly invalid address means the person likely left. Then find their new role.
3. **LeadMagic Job Change Detector** at 3 credits per check (about $0.025 to $0.06) **[V]**.
4. **Search-engine check.** Query Serper with `site:linkedin.com/in "First Last" "{old company}"` and read the snippet. This costs about $0.001 and is ToS-safe, because you're querying Google, not LinkedIn.
5. Paid "champion tracking" tools (UserGems, Champify and similar) cost $10k+/yr. Skip them.

### 1.5 Headcount growth

- **Free proxies:**
  - Open-job count over time from §1.1. This is a strong leading indicator.
  - For UK firms, Companies House filings (employee numbers appear in accounts).
  - For US public companies, `dei:EntityNumberOfEmployees` from the SEC XBRL companyfacts endpoint.
- **Cheap paid:**
  - PDL company enrich returns `employee_count` and `employee_count_by_month`/growth fields (1 credit; 100 free per month).
  - Coresignal company records include headcount history (from $49/mo).
  - Snapshot your own data: store the `employee_count` from each enrichment and compute the delta yourself.

### 1.6 Technographics and tech stack

| Option | Cost | How |
|---|---|---|
| **Self-fingerprint (recommended)** | Free | Fetch the homepage and match the HTML, headers, cookies, script srcs and meta tags against the open fingerprint DB. Options: **`projectdiscovery/wappalyzergo`** (Go), **`enthec/webappanalyzer`** (maintained fork of the Wappalyzer JSON rules, usable from TS/Python), or `httpx -td`. |
| **DNS fingerprint** | Free | DNS-over-HTTPS via `https://dns.google/resolve?name={domain}&type=MX` (also `TXT`, `CNAME`). MX tells you Google Workspace vs M365 vs Proofpoint/Mimecast. TXT records reveal SaaS verifications (`atlassian-domain-verification`, `hubspot`, `stripe-verification`, `docusign`, `facebook-domain-verification`, `MS=`, `zoom`, …). SPF `include:` lists show sending tools (sendgrid, mailchimp, salesforce, hubspot, zendesk). This is the single cheapest high-signal technographic. |
| **Job-post inference** | Free | LLM-extract the tools named in job descriptions ("experience with Snowflake, dbt"). This is TheirStack's method. |
| BuiltWith API | $295/mo (Basic) to $995/mo **[3P]** | Has history ("installed X on date"), but it's overkill for one user. A free single-lookup API exists with heavy limits [?]. |
| Wappalyzer API | $250/mo Pro, $450 Business **[3P]** | — |
| LeadMagic Technographics | 1 credit ≈ $0.01 to $0.02 **[V]** | Cheapest paid per-lookup option. |
| TheirStack | as above | Tech derived from job posts. |

### 1.7 Website changes

- **Self-hosted:** run the open-source **changedetection.io** in Docker, or a cron that fetches `r.jina.ai/{url}`, hashes the markdown and diffs it. Have an LLM (Haiku) summarise the diff ("new pricing tier", "new /careers role", "new SOC2 page").
- **Good pages to watch:** `/pricing`, `/customers`, `/careers`, `/security`, `/integrations`, `/sitemap.xml` (new URLs are cheap to diff) and `/changelog`.
- **Cost:** about $0 plus LLM tokens (Haiku at $0.10/M input makes a page diff about $0.0005).

### 1.8 Web intent and visitor identification

| Tool | Free | Paid | Notes |
|---|---|---|---|
| **RB2B** | Free tier (about 150 resolutions/mo); reportedly company/LinkedIn only and no contact emails since Jan 2026 **[3P]** | Starter $79, Pro $149, Pro+ $199/mo **[3P]** | US-only person-level identification. Relies on identity-graph cookies. **High legal risk in CA, EU and UK** (wiretap/CIPA suits). Needs a privacy policy disclosure. |
| **Snitcher** | Trial (a free tier is claimed by some sources) | About $49 to $529/mo by identified companies **[3P]** | Company-level (IP to company), so it's GDPR-friendlier. Has webhooks and an API. |
| Dealfront/Leadfeeder | Free tier only after a trial lapses (100 companies, 7-day history) | From $99 to $139/mo **[3P]** | — |
| Clearbit Reveal / weekly visitor report | **Discontinued** (free tools ended 30 April 2025) | Breeze Intelligence inside HubSpot only | — |
| **DIY** | Free | — | Log visitor IPs at your edge (Cloudflare Worker), then look up the ASN/org with IPinfo Lite (free country+ASN tier) [?]. Many hits are ISPs, but corporate ASNs (e.g. "ACME-CORP") are a real signal. Expect a low match rate (about 5 to 15%). |

### 1.9 GitHub activity

- **REST:** `https://api.github.com/orgs/{org}/events`, `/orgs/{org}/repos?sort=pushed`, `/repos/{o}/{r}/stargazers` (with the `Accept: application/vnd.github.star+json` header for timestamps). **[V 200]**
- **Limits:** 60 requests/hr unauthenticated, 5,000/hr with a personal access token (`Authorization: Bearer ghp_…`).
- **Signals:** a new repo using a competitor SDK; spikes in stars or contributors; and "who starred my/competitor repo". Mapping a stargazer to a person relies on their public profile (company and blog fields). That's fine to read, but outreach is your responsibility.
- **Bulk:** GH Archive (gharchive.org, on BigQuery).

### 1.10 Social and LinkedIn activity: legal and ToS notes

- **LinkedIn's user agreement prohibits scraping** with any tool.
  - **hiQ v. LinkedIn:** the 9th Circuit (2022) held that scraping *public* pages likely isn't "unauthorized access" under the CFAA. The district court later found hiQ **breached LinkedIn's User Agreement**, and the case ended in December 2022 with a judgment and injunction against hiQ.
  - **Proxycurl:** sued in January 2025 (fake accounts, logged-in scraping), it shut down around July 2025 under a permanent injunction.
  - **Meta v. Bright Data (2024):** logged-out scraping of public data was held not to breach Meta's terms. This is helpful precedent, but it isn't LinkedIn.
- **Practical posture for a personal tool:**
  - Never automate a logged-in LinkedIn account. It's the fastest way to get banned, and it's the conduct LinkedIn litigates.
  - Prefer search-engine snippets (Serper) and vendor APIs (Icypeas, LeadMagic, Prospeo and PDL "profile" endpoints). That shifts collection risk to the vendor, but it doesn't remove your GDPR obligations.
  - Apify "no-cookie" LinkedIn actors cost about $1.50 to $12 per 1k profiles **[3P]**. They're ToS-violating and carry vendor-continuity risk.
- **X/Twitter API** is paid (Basic tier has historically been about $200/mo) [?]. **Bluesky** has a free, open firehose and search (`https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=`).

### 1.11 Product launches

- **Product Hunt API v2 (GraphQL):** `POST https://api.producthunt.com/v2/api/graphql`, `Authorization: Bearer {developer_token}`.
  - The complexity budget is about 6,250 points per 15 minutes **[3P]**.
  - The default terms are non-commercial, so contact PH for commercial use [?]. A personal tool should be fine.
  - Example query: `posts(postedAfter:…, order:NEWEST){ edges{ node{ name website votesCount makers{ name twitterUsername }}}}`.
- **Show HN:** `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn`
- **Company changelogs and RSS:** cover these via the website-change watcher (§1.7).

### 1.12 Reviews (G2 and others)

- **G2** has no free public API for reading reviews. G2 Buyer Intent is an enterprise add-on (five figures). Scraping is Cloudflare-protected and ToS-prohibited.
- **Cheap alternatives:**
  - Trustpilot public pages (also ToS-restricted).
  - Capterra.
  - Use Serper `site:g2.com/products/{slug}/reviews` to detect new review counts from snippets.
  - Watch competitor G2 "alternatives" pages via the website-change watcher (§1.7).
- **Verdict:** low ROI for a solo user. Skip it, or settle for a snippet-level signal.

### 1.13 Domain, DNS and certificate changes

| Signal | Source | Notes |
|---|---|---|
| New subdomains/certs (new product, new region, new tool such as `status.`, `docs.`, `auth0`) | **crt.sh**: `https://crt.sh/?q=%25.{domain}&output=json&exclude=expired` | Free, no key. **Very flaky** (502 during my test) **[V]**. Use long timeouts, retries and caching. |
| Same, more reliable | **Cert Spotter**: `https://api.certspotter.com/v1/issuances?domain={d}&include_subdomains=true&expand=dns_names&after={id}` | About 100 hostname queries/day unauthenticated (10 with subdomains) **[3P]**. Bearer key for more (paid). |
| MX/TXT/SPF change (e.g. move to Google Workspace, adding HubSpot or Salesforce) | DoH: `https://dns.google/resolve?name=…&type=TXT` or `https://cloudflare-dns.com/dns-query?name=…&type=MX` (`accept: application/dns-json`) | Free. Snapshot and diff weekly. |
| Newly registered lookalike/new-brand domains | WhoisDS/ICANN CZDS zone files (free with approval) | Advanced use. |

### 1.14 Government contracts and other public-record signals

| Source | Endpoint | Auth/limits |
|---|---|---|
| **USAspending.gov** (awards) | `POST https://api.usaspending.gov/api/v2/search/spending_by_award/` | Free, no key **[V 200]**. Filter by recipient name/UEI, NAICS and date. |
| **SAM.gov Opportunities/Entity** | `https://api.sam.gov/opportunities/v2/search?api_key=…&postedFrom=…` | Free key from your SAM.gov account. Quota is reportedly about 10 to 40/day for new non-federal users and about 1,000/day once approved **[3P/?]**. |
| UK Contracts Finder / Find a Tender | `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search` | Free (OCDS JSON). |
| EU TED | `https://api.ted.europa.eu/v3/notices/search` | Free. |
| SEC 8-K (exec changes, item 5.02), S-1, 10-K | `data.sec.gov/submissions` | Free. Item 5.02 is a free exec-change signal for public companies. |
| WARN layoff notices | State sites; aggregated at warntracker.com / layoffs.fyi | Free; mostly scraping. |
| Trademark filings (new product names) | USPTO Open Data APIs | Free key. |

### 1.15 Signal summary matrix

| Signal | Cheapest source | Cost | Reliability | Legal risk |
|---|---|---|---|---|
| Hiring | ATS JSON (Greenhouse, Lever, Ashby, SmartRecruiters) | $0 | High | Low |
| Funding (US) | SEC Form D + Google News RSS | $0 | High (US) / Med | Low |
| News | Google News RSS + GDELT | $0 | Medium | Low |
| Job change | Re-enrich diff + LeadMagic detector | ≈$0.01 to $0.06 per check | Medium | Low/Med |
| Headcount | Open-job trend; PDL free 100/mo | $0 to $0.28 | Medium | Low |
| Tech stack | Self-fingerprint + DNS TXT/MX | $0 | Med-High | Low |
| Website change | changedetection.io / Jina + diff | $0 | High | Low |
| Visitor ID | Snitcher (company) / RB2B (person, US) | $0 to $79+/mo | Medium | **Med-High (RB2B)** |
| GitHub | GitHub REST with PAT | $0 | High | Low |
| Launches | Product Hunt GraphQL, HN Algolia | $0 | High | Low |
| Reviews | Serper snippets | ≈$0.001 | Low | Med |
| DNS/CT | DoH + crt.sh/Cert Spotter | $0 | Medium (crt.sh flaky) | Low |
| Gov contracts | USAspending, SAM.gov | $0 | High | Low |
| LinkedIn posts | Avoid; at most Serper snippets | — | — | **High** |

---

## 2. DATA (contacts and companies)

### 2.1 Contact-data APIs: free tiers and per-record prices

Effective $/record figures are the **cheapest self-serve monthly plan price ÷ credits**. Most vendors charge only on success (no result, no charge) unless noted.

| Vendor | Free | Entry paid | Email credit | Mobile credit | ≈ $ per found email / mobile | API | Status |
|---|---|---|---|---|---|---|---|
| **Hunter** | 50 credits/mo **[V]** | €49/mo for 2,000 (€34 annually) **[V]** | 1 (verify: 0.5) | n/a | €0.017 to €0.025 / — | Yes, all tiers. `?api_key=` query param. | Active |
| **Icypeas** | 50 promo credits **[V]** | $19/mo for 1,000; $89 for 10k; yearly $190 for 12k **[V]** | 1 (verify: 0.1) | "coming soon" | **$0.019 → $0.009** / — | All plans. Header `Authorization: {API_KEY}`. Async (submit, then poll/webhook). | Active. **Credits never expire and roll over.** |
| **LeadMagic** | **None** **[V]** | $99/mo for 5,000 ($0.0198/credit) **[V]** | 1 (validate: 0.25) | 5 | $0.02 / $0.10 | All plans. Header `X-API-Key`. 600 rpm. | Active. Also job change (3), funding (4), technographics (1), employee finder (0.05/employee). |
| **Findymail** | 10 credits **[V]** | $99/mo for 5,000 finder + 5,000 verifier **[V]** | 1 | 10 | $0.02 / $0.20 | Yes. Bearer token. | Active. Strong on catch-alls. |
| **Prospeo** | 75 credits/mo **[3P]** | About $39 to $49/mo for 1,000 **[3P]** | 1 | 10 | ≈$0.04 / $0.40 | All plans, header `X-KEY` **[3P]** | Active. Pricing page didn't render for me. |
| **FullEnrich** (waterfall of 15+ vendors) | 50 credits **[V]** | €55/mo for 1,000 **[V]** | 1 (personal: 3) | 10 | €0.055 / **€0.55** | Pro+. Bearer token. Async with webhook. | Active. Best mobile hit rate per $ for low volume. |
| **BetterContact** (waterfall) | 50 credits **[V]** | **$15/mo for 200**; $49/mo for 1,000 **[V]** | 1 | 10 | $0.049 / **$0.49** | All plans. Header `X-API-Key`. Async. | Active. Cheapest entry point for occasional mobiles. |
| **Apollo** | Free plan exists; whether it includes API access is disputed **[3P]** | $49 to $119/user/mo | 1 | +8 (phone) | Varies | Header `x-api-key`. API key likely needs a paid plan [?]. | Active. API credit rates were published July 2026 **[3P]**. Great DB, mediocre email accuracy. |
| **People Data Labs** | 100 credits/mo, **contact fields hidden** **[V]** | $98/mo for 350 (≈$0.28/record) **[V]** | (whole record) | (in record) | $0.28 per record | Header `X-Api-Key`. Rate limits per plan. | Active. Best for **firmographics + LinkedIn URL + work history**, not for cheap email. |
| **Snov.io** | 50 credits/mo **[3P]** | About $39/mo **[3P]** | 1 | — | ≈$0.04 | OAuth client-credentials | Active |
| **RocketReach** | Small trial | API only on Ultimate (about $207/mo annual) **[3P]** | — | — | Expensive | — | Not worth it |
| **Lusha** | About 40 to 70 credits/mo free [?] | About $37 to $50/mo **[3P]** | 1 | 5 to 10 (sources disagree) | — | API on higher tiers [?] | Phones decent in US/EU |
| **ContactOut** | Free (limited) | From $49/mo **[3P]**; API is sales-led | — | — | — | Enterprise | Strong on personal emails; ToS-grey sourcing |
| **Kaspr** | 15 email + 5 phone + 5 direct/mo **[3P]** | About €49+/mo [?] | — | — | — | Paid tiers | EU-focused phones |
| **Wiza** | Small trial | $49/user/mo for 100 emails + 100 phones **[3P]** | — | — | ≈$0.49 | Paid | LinkedIn/Sales Nav-centric |
| **Dropcontact** | Trial | About €24 to €79/mo for 500 (sources conflict) **[3P]** | 1 (**charged even on miss**) | — | ≈€0.05 to €0.16 | Yes | EU/GDPR-native (no stored DB) |
| **Datagma** | Trial | $39 to $69/mo **[3P]** | 1 | more | — | Yes | Niche |
| **Coresignal** | Trial (terms conflict) | From $49/mo; bulk datasets from about $1k **[3P]** | — | — | — | Header `apikey` | Raw LinkedIn-derived employee, company and job data. Good for bulk/headcount. |
| **Clearbit / Breeze** | Free tools gone (Logo API ended 8 Dec 2025; others 30 April 2025) | HubSpot Breeze Intelligence credits, inside HubSpot only | — | — | — | No standalone API for new users [?] | **Discontinued as a standalone option** |
| **Proxycurl** | — | — | — | — | — | — | **Shut down (July 2025)**. Successor NinjaPear covers company data/monitoring, not LinkedIn profiles. |
| Proxycurl-style alternatives | — | Icypeas profile scraper (1.5 credits), LeadMagic profile (1), Prospeo enrich, PDL, Coresignal, Apify actors | — | — | ≈$0.01 to $0.28 | — | Pick API vendors over raw scrapers |

### 2.2 Email verification

| Vendor | Free | Price | ≈ per 1k | Notes |
|---|---|---|---|---|
| **MillionVerifier** | 100 credits **[V]** | **$89 per 50k** ($0.00178); $449 per 1M **[V]** | **$1.8** | Credits never expire. API at `https://api.millionverifier.com/api/v3/?api={key}&email=…`. Weak on catch-alls (returns "catch_all"). |
| **Reoon** | 600/mo free **[3P]** | About $11.90 to $12 per 10k one-time **[3P]** | **$1.2** | Cheapest. Has "power" mode with SMTP plus catch-all heuristics. |
| ZeroBounce | 100/mo **[3P]** | About $64 to $80 per 10k **[3P]** | $6 to $8 | Best-known; pricey. |
| NeverBounce | Trial | About $50 to $80 per 10k **[3P]** | $5 to $8 | Credits reportedly expire after 12 months. |
| Icypeas verify | — | 0.1 credit ≈ **$0.002** **[V]** | $1 to $2 | Free if you already hold Icypeas credits. |
| LeadMagic validate | — | 0.25 credit ≈ $0.005 **[V]** | $5 | — |
| Findymail | Found emails are pre-verified | — | — | 5k verifier credits are bundled with Starter. |

Verifying an email returned by Findymail, LeadMagic or Prospeo is usually redundant, because they verify before charging. Verify emails from Apollo, PDL or pattern-guessing. For **catch-all** domains, use Findymail, BetterContact or Icypeas catch-all verification, or Reoon power mode.

### 2.3 Web search and fetch APIs for the AI research agent

| API | Free | Paid | Auth | Notes |
|---|---|---|---|---|
| **Serper** (Google SERP) | **2,500 queries once** **[V]** | About $1/1k on prepaid packs (larger packs about $0.30 to $0.50/1k) **[3P]** | Header `X-API-KEY`. `POST https://google.serper.dev/search` with `{"q":…}`. Also `/news`, `/places`, `/scrape`. | Cheapest Google results. Best default for the agent. |
| **Brave Search** | **$5 credit/mo (≈1,000 queries)**. The old 2k/5k free plans are gone for new users. | $5/1k search; Answers $4/1k plus tokens **[V]** | Header `X-Subscription-Token`. `GET https://api.search.brave.com/res/v1/web/search?q=` | Independent index; 50 qps. |
| **Exa** | **$10 free credit, reset monthly** (≈2,500 Instant searches) **[V]** | $4/1k Instant; $7/1k Fast/Auto; $12/1k Deep; contents $1/1k pages **[V]** | Header `x-api-key`. `POST https://api.exa.ai/search` | Semantic and "find similar companies". Great for lookalikes. |
| **Tavily** | **1,000 credits/mo** **[V]** | $0.008/credit PAYG **[V]** | Bearer. `POST https://api.tavily.com/search` | LLM-ready snippets. Advanced search costs 2 credits. |
| **SerpAPI** | 250/mo **[V]** | $25/mo for 1k; $75 for 5k **[V]** | `?api_key=` | Pricier, but has the most engines (Google Jobs, Maps, LinkedIn-less). |
| **Jina Reader** | `r.jina.ai/{url}` works with **no key at 20 RPM** **[V]**; a new key gets 10M free tokens | Token-based | Bearer (optional) | URL to clean markdown. `s.jina.ai` (search) needs a key. |
| **DuckDuckGo** | Instant Answer API `https://api.duckduckgo.com/?q=…&format=json` **[V 200]** | — | none | **Not web results.** Only the abstract/infobox. HTML scraping of DDG is ToS-grey and gets rate-limited. Don't rely on it. |
| **OpenRouter web plugin** | — | Exa engine: **$0.007/request** (up to 10 results; extra results $0.001 each); Deep is $0.012; Perplexity/Parallel $0.005; native = provider pass-through **[V]** | Your OpenRouter key | Enable via `:online` suffix, `"plugins":[{"id":"web","engine":"exa","max_results":5}]`, or the `openrouter:web_search` server tool (model decides when to search). The models API lists `web_search` at $0.01 (Anthropic) and $0.014 (Google) per native call **[V]**. |

**Agent recipe:** Serper (search) → Jina Reader (fetch) → Haiku 5.5 (extract). That's about $0.001 + $0 + about $0.001 to $0.003, so roughly **$0.003 to $0.005 per research cell**. Use Exa for "companies like X".

### 2.4 LLMs on OpenRouter (live from `https://openrouter.ai/api/v1/models`, 2026-10-12) **[V]**

| Slug | Input $/M | Output $/M | Context | Notes |
|---|---|---|---|---|
| **`anthropic/claude-haiku-5.5`** | **0.10** | **0.50** | 1M | `:batch` variant is 0.05/0.25. Third-party sources report a long-context surcharge above 100K tokens/request (about $0.50/$2.50) [3P]. Cache read is about $0.01/M [3P]. Alias `~anthropic/claude-haiku-latest`. |
| `anthropic/claude-haiku-4.5` | 1.00 | 5.00 | 200K | Legacy; 10× pricier. |
| `google/gemini-2.5-flash-lite` | 0.10 | 0.40 | 1M | Cheapest Gemini. |
| `google/gemini-3.1-flash-lite` | 0.25 | 1.50 | 1M | — |
| `google/gemini-3.5-flash-lite` | 0.30 | 2.50 | 1M | — |
| `google/gemini-2.5-flash` | 0.30 | 2.50 | 1M | — |
| `google/gemini-3-flash-preview` | 0.50 | 3.00 | 1M | — |
| `google/gemini-3.6-flash` / `3.7-flash` / `3.8-flash` | 0.75 | 3.75 | 1M | `:batch` variants are half price. |
| `google/gemini-3.5-flash` | 1.50 | 9.00 | 1M | — |
| `google/gemini-2.5-pro` | 1.25 | 10.00 | 1M | — |
| `google/gemini-3.1-pro-preview` | 2.00 | 12.00 | 1M | — |

**Recommendation:** make `anthropic/claude-haiku-5.5` the default for extraction, classification and agent steps. Use `google/gemini-2.5-flash-lite` as the bulk fallback. Use `:batch` variants for overnight backfills.

### 2.5 Open and free datasets

| Dataset | Access | Cost/limits | Use |
|---|---|---|---|
| **SEC EDGAR** | `data.sec.gov/submissions/CIK{10}.json`, `/api/xbrl/companyfacts/CIK{10}.json`; nightly `submissions.zip`/`companyfacts.zip`; `https://www.sec.gov/files/company_tickers.json` | Free, no key. ≤10 rps plus a `User-Agent` with your email **[V]**. | US public-company firmographics, employees, revenue, execs, Form D private raises. |
| **UK Companies House** | `https://api.company-information.service.gov.uk/search/companies?q=` and `/company/{number}`, `/officers` | Free key. **HTTP Basic auth with the key as username and a blank password.** Limit is 600 requests per 5 minutes **[V: 401 without key; limit per official docs]**. Free bulk monthly snapshot download. | UK firmographics, SIC, officers (directors = decision-makers), filings. |
| **OpenCorporates** | `api.opencorporates.com/v0.4/…` | **Paid** (from about £2,250/yr; requests 401 without a token **[V]**). The free/open-data tier is for approved public-benefit use only. | Skip. Go direct to registries. |
| **US state registries** | Varies. NY (data.ny.gov Socrata API, free), CO (data.colorado.gov), FL (Sunbiz bulk SFTP, free), WA, OR, CT and others publish open data. DE and CA: search UI only. | Free | Formation date, registered agent, status, new-entity signal. |
| **Wikidata** | SPARQL `https://query.wikidata.org/sparql?query=…&format=json` | Free (CC0). 60s query timeout; send a User-Agent. | Large and notable companies: HQ, industry, employees, founders, website, LinkedIn company ID (P4264), Crunchbase ID (P2088). |
| **GLEIF (LEI)** | `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=` | Free, no key | Legal entity, parent/child hierarchy. |
| **OpenStreetMap / Overture Maps Places** | Overture GeoParquet on S3/Azure (query with DuckDB); OSM Overpass API | Free. Overture Places is CDLA-Permissive-2.0 [?]; OSM is ODbL (share-alike). | Local/SMB businesses, locations, websites, phones. |
| **Common Crawl** | Index `https://index.commoncrawl.org/CC-MAIN-YYYY-WW-index?url=*.acme.com&output=json`; WARCs on S3 | Free | Historical page snapshots, tech fingerprinting at scale, email pattern mining from public pages. |
| **Clearbit autocomplete** | `https://autocomplete.clearbit.com/v1/companies/suggest?query=stripe` | Free, no key. **Still returning 200 on 2026-10-12 [V]**, but the `logo` field is null and it's undocumented, so it could die anytime. | Name → domain resolution. |
| **Logos** | logo.dev (`https://img.logo.dev/{domain}?token=pk_…`, free tier, key required **[V 401 without]**), Google favicons `https://www.google.com/s2/favicons?domain={d}&sz=128` | Free | Replacement for the Clearbit logo API. |
| ProPublica Nonprofit Explorer | `https://projects.propublica.org/nonprofits/api/v2/search.json?q=` | Free | Nonprofits (990 data, revenue, officers). |
| USAspending / SAM.gov | above | Free | Gov contractors with UEI, NAICS, address and POCs. |

### 2.6 Firmographics: cheapest stack

1. **Name to domain:** Clearbit autocomplete (free, fragile), then Serper (`"{name}" official site`), then Exa.
2. **Domain to firmographics:**
   - Scrape the site yourself (Jina Reader → Haiku extracts description, industry, HQ, socials and the LinkedIn company URL from the footer). Free plus about $0.001.
   - Add registries (SEC, Companies House, Wikidata, GLEIF).
3. **Paid fill for headcount, industry and revenue:**
   - **Icypeas Company Scraper** (0.5 credit ≈ $0.005 to $0.01) **[V]**.
   - **PDL Company Enrich** (100 free/mo, then about $0.28) **[V]**.
   - Apollo `organizations/enrich` (1 credit) **[3P]**.
   - LeadMagic company search (1 credit).

### 2.7 How data brokers and bulk purchases work

- **Bulk datasets:**
  - PDL (custom annual bulk licences), Coresignal (datasets from about $1k, flat files of companies, employees and jobs refreshed monthly), TheirStack (jobs and technographics datasets) and BuiltWith (lists).
  - You sign a licence (usually internal-use only, no resale, delete-on-termination clauses) and receive Parquet/JSONL on S3.
  - Typical starting prices run from $1k to five figures per year **[3P]**.
  - For a solo user, buying a **one-off static slice** (e.g. "US SaaS companies 11-200 employees" from Coresignal or PDL) can be cheaper than API calls if you need thousands of rows. Ask for a filtered sample-sized deal.
- **Marketplaces:** Datarade, AWS Data Exchange and Snowflake Marketplace list B2B datasets with sample files.
- **Legal considerations**
  - **GDPR (EU/UK):** B2B work emails are personal data.
    - You need a lawful basis, usually legitimate interest with a documented LIA, plus an **Art. 14 notice** within 30 days of collecting data not obtained from the person. In practice that means a short privacy line in your first email.
    - You also need opt-out handling and data minimisation.
    - Cold email to individuals at corporates is generally allowed under the UK PECR "corporate subscriber" rule. It is stricter in Germany (UWG requires prior consent for email marketing) and in some other EU states.
    - Prefer GDPR-native vendors (Dropcontact, Icypeas, FullEnrich) for EU contacts.
  - **CCPA/CPRA (California):**
    - It applies to businesses that meet the revenue or data-volume thresholds ($25M+ revenue, 100k+ consumers, or 50%+ of revenue from selling data). **A personal, single-user tool almost certainly doesn't meet them.**
    - **California's Delete Act** requires anyone who *sells* personal data of consumers they don't have a direct relationship with to **register as a data broker**. Since 1 August 2026, brokers must poll the **DROP** deletion platform every 45 days. Fines run to $200 per day per consumer or request.
    - **If you never sell or share the data, you are not a broker.** Don't resell kineticsand data.
  - **Other broker registries:** Vermont, Texas and Oregon have similar registration laws for data sellers. They also apply only if you sell data.
  - **CAN-SPAM (US):** commercial email needs a physical address, a working unsubscribe, honouring opt-outs within 10 business days, and non-deceptive headers and subjects.
  - **TCPA (US phones):** don't autodial or text mobiles without consent. Manual dialling of B2B mobiles is the norm, but check DNC lists for anything consumer-like.
  - **Vendor ToS:** most enrichment ToS forbid caching or reselling. Storing results in your own sheet for your own outreach is the normal permitted use.

---

## 3. Recommended waterfalls (cheapest effective order)

Stop at the first confident hit. Cache everything by `(domain)` or `(linkedin_url | name+domain)` so you never pay twice.

### 3.1 Work email

1. **Cache/DB hit** ($0).
2. **Pattern guess + SMTP verify.** Derive the domain pattern from any known email at that company (Hunter domain-search returns the `pattern` field; 1 credit buys many people). Generate the candidate and verify with **Reoon/MillionVerifier** (about $0.0012 to $0.0018). Accept only `valid` results, not catch-all.
3. **Icypeas** email finder ($0.009 to $0.019 per hit; credits never expire).
4. **Hunter** email finder (free 50/mo first, then about €0.017).
5. **LeadMagic** or **Findymail** ($0.02 per hit; strong on catch-all domains).
6. **Prospeo** (about $0.04).
7. **BetterContact/FullEnrich** waterfall as a last resort ($0.05; they re-query 15+ vendors, so success rate is highest).
8. Final verify only for sources that don't pre-verify (pattern, Apollo, PDL).

**Expected cost per found email:** about $0.01 to $0.03.

### 3.2 Mobile phone

Mobiles are expensive. Gate them behind a rule (e.g. only for score ≥ X or tier-1 accounts).

1. Cache.
2. **BetterContact** ($0.49 per found mobile at $49/1k credits; $15 entry plan) **or** **FullEnrich** (€0.55). Both are waterfalls, charged only on found and verified numbers. Pick one. BetterContact is cheaper at low volume.
3. **LeadMagic Mobile Finder** (5 credits ≈ $0.10) **as step 1 instead if you're already on a LeadMagic plan**. It's the cheapest per hit but has lower coverage.
4. Findymail phone (10 credits ≈ $0.20) or Prospeo mobile (10 credits).
5. Apollo (+8 credits) only if you're on a paid Apollo plan anyway.

**Expected cost:** $0.10 to $0.55 per found mobile, with 40 to 60% coverage (US best, EU worse).

### 3.3 Company firmographics

1. Cache.
2. **Free:**
   - Website scrape (Jina) → Haiku extraction.
   - DNS (MX/TXT) for tech.
   - Registries (SEC for US public companies and Form D; Companies House for the UK; GLEIF; Wikidata for notable companies).
   - ATS feed for open roles.
3. **Icypeas Company Scraper** (0.5 credit).
4. **PDL Company Enrich** (100 free/mo, then $0.28; best structured headcount, industry and funding).
5. LeadMagic company search/funding/technographics (1 to 4 credits) for specific gaps.

**Expected cost:** about $0 to $0.01 per company. PDL only for gaps.

### 3.4 LinkedIn URL (person)

1. Cache.
2. **Serper** Google search `site:linkedin.com/in "{first} {last}" "{company}"`. About $0.0003 to $0.001 per query. Have Haiku pick the right result using the title and company in the snippet. Expect about 70 to 85% hit rate.
3. **Icypeas Person Profile URL Finder** (1 credit ≈ $0.01).
4. **LeadMagic** "Email to B2B Profile" (10 credits) if you only have an email, or Icypeas reverse email (10 credits).
5. **PDL Person Enrich** (returns `linkedin_url`; free 100/mo, contact fields hidden on free, but the LinkedIn URL is included [?]).
6. Exa search (`category: "linkedin profile"` [?]) as a semantic fallback.

For **company LinkedIn URLs**, use the website footer scrape first, then Wikidata P4264, then Serper `site:linkedin.com/company`, then Icypeas Company Profile URL Finder (1 credit).

---

## 4. Adapter shortlist (what to build first)

### Free signal adapters

| Adapter | Endpoint | Auth |
|---|---|---|
| greenhouse | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | none |
| lever | `GET https://api.lever.co/v0/postings/{company}?mode=json` | none |
| ashby | `GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` | none |
| smartrecruiters | `GET https://api.smartrecruiters.com/v1/companies/{id}/postings` | none |
| sec_formd | `GET https://efts.sec.gov/LATEST/search-index?forms=D&q="{name}"` and `data.sec.gov/submissions/CIK{10}.json` | none, plus required `User-Agent` |
| google_news | `GET https://news.google.com/rss/search?q=…&hl=en-US&gl=US&ceid=US:en` | none |
| gdelt | `GET https://api.gdeltproject.org/api/v2/doc/doc?query=…&mode=artlist&format=json` | none (≤1 request per 5 s) |
| dns | `GET https://dns.google/resolve?name={d}&type=TXT\|MX` | none |
| crtsh / certspotter | `https://crt.sh/?q=%25.{d}&output=json` / `https://api.certspotter.com/v1/issuances?domain={d}&include_subdomains=true&expand=dns_names` | none / optional Bearer |
| github | `https://api.github.com/orgs/{org}/events` | Bearer PAT |
| producthunt | `POST https://api.producthunt.com/v2/api/graphql` | Bearer developer token |
| hn | `https://hn.algolia.com/api/v1/search_by_date?query=…` | none |
| usaspending | `POST https://api.usaspending.gov/api/v2/search/spending_by_award/` | none |
| companies_house | `https://api.company-information.service.gov.uk/company/{no}` | Basic (key as username) |
| webdiff | `GET https://r.jina.ai/{url}` + hash/diff | none (or Bearer for 500 RPM) |

### Paid data adapters (in priority order)

| Adapter | Base / key endpoints | Auth |
|---|---|---|
| **icypeas** | `POST https://app.icypeas.com/api/email-search` (`firstname, lastname, domainOrCompany`); `POST /api/email-verification`; results via `POST /api/bulk-single-searchs/read` or webhook [verify paths in docs] | Header `Authorization: {API_KEY}` |
| **hunter** | `GET https://api.hunter.io/v2/email-finder?domain=&first_name=&last_name=`; `/v2/domain-search?domain=`; `/v2/email-verifier?email=` | `?api_key=` (or `X-API-KEY` header) |
| **leadmagic** | `POST https://api.leadmagic.io/email-finder`; `/mobile-finder`; `/email-validate`; `/profile-search`; `/job-change-detector` [verify paths] | Header `X-API-Key` |
| **bettercontact** | `POST https://app.bettercontact.rocks/api/v2/async` then `GET /api/v2/async/{id}` (or webhook) [verify] | Header `X-API-Key` |
| **pdl** | `GET https://api.peopledatalabs.com/v5/person/enrich?…`; `/v5/company/enrich?website=` | Header `X-Api-Key` |
| **millionverifier** | `GET https://api.millionverifier.com/api/v3/?api={key}&email={e}&timeout=10` | query param |
| **serper** | `POST https://google.serper.dev/search` `{"q":…}` | Header `X-API-KEY` |
| **exa** | `POST https://api.exa.ai/search` (`type`, `numResults`, `contents`) | Header `x-api-key` |
| **openrouter** | `POST https://openrouter.ai/api/v1/chat/completions` with model `anthropic/claude-haiku-5.5` | Bearer |

Paths marked [verify] are from vendor docs patterns and memory. Confirm them against each vendor's API reference when you implement them.

**Suggested minimum monthly spend for a solo user:**

- Icypeas Basic ($19) or yearly ($190), with credits that never expire.
- BetterContact Starter ($15), only if you need mobiles.
- MillionVerifier one-off $89 per 50k, or Reoon about $12 per 10k.
- Serper prepaid (about $50 lasts months).
- OpenRouter pay-as-you-go.

On top of that, use the free tiers of Hunter (50/mo), PDL (100/mo), Exa ($10/mo), Tavily (1k/mo), Brave ($5/mo) and Jina. **That's about $35 to $60/mo all-in.**

---

## 5. Sources

**Status changes**

- [Goodbye Proxycurl (founder post)](https://nubela.co/blog/goodbye-proxycurl/)
- [LinkedIn wins case vs Proxycurl (Social Media Today)](https://www.socialmediatoday.com/news/linkedin-wins-legal-case-data-scrapers-proxycurl/756101/)
- [Proxycurl status in 2026 / NinjaPear](https://nubela.co/blog/what-is-proxycurl-api-now-in-2026-im-the-founder/)
- [HubSpot: sunset of Clearbit free Logo API](https://developers.hubspot.com/changelog/upcoming-sunset-of-clearbits-free-logo-api)
- [Clearbit: The future of Clearbit's free tools](https://clearbit.com/blog/the-future-of-clearbits-free-tools)
- [Clearbit changelog](https://www.clearbit.com/changelog)

**LLM and search pricing**

- [OpenRouter models API (live pricing)](https://openrouter.ai/api/v1/models)
- [OpenRouter web search docs](https://openrouter.ai/docs/web-search)
- [OpenRouter Haiku 5.5 page](https://openrouter.ai/compare/anthropic/claude-haiku-5.5)
- [Haiku 5.5 long-context pricing note (eesel)](https://www.eesel.ai/blog/claude-haiku-5-5-pricing)
- [Brave Search API](https://brave.com/search/api/)
- [Brave free tier change (CostBench)](https://www.costbench.com/software/ai-search-apis/brave-search-api/free-plan/)
- [Exa pricing](https://exa.ai/pricing)
- [Tavily pricing](https://www.tavily.com/pricing)
- [Serper](https://serper.dev/)
- [SerpAPI pricing](https://serpapi.com/pricing)
- [Jina Reader](https://jina.ai/reader/)

**Contact-data vendors**

- [Hunter pricing](https://hunter.io/pricing)
- [Icypeas pricing](https://www.icypeas.com/pricing)
- [LeadMagic pricing](https://leadmagic.io/pricing)
- [Findymail pricing](https://www.findymail.com/pricing/)
- [FullEnrich pricing](https://fullenrich.com/pricing)
- [BetterContact pricing](https://bettercontact.rocks/pricing/)
- [PDL person pricing](https://www.peopledatalabs.com/pricing/person)
- [PDL pricing guide (Cleanlist)](https://www.cleanlist.ai/blog/2026-09-01-people-data-labs-pricing-guide)
- [Prospeo pricing (Emelia)](https://emelia.io/hub/prospeo-pricing)
- [Prospeo pricing (ColdIQ)](https://coldiq.com/blog/prospeo-pricing)
- [Apollo API credit rates (usagepricing)](https://usagepricing.com/blueprint/activity/apollo-2026-07-18-api-credit-rates)
- [Apollo rate limits docs](https://docs.apollo.io/docs/rate-limits)
- [Lusha pricing (Zeliq)](https://www.zeliq.com/blog/lusha-pricing)
- [RocketReach/Wiza/Kaspr/Snov (Enrich.so)](https://www.enrich.so/blog/kaspr-alternatives)
- [Dropcontact pricing (Leadhaste)](https://leadhaste.com/blog/dropcontact-pricing-2026)
- [Coresignal pricing (ZoomInfo pipeline)](https://pipeline.zoominfo.com/sales/coresignal-pricing)
- [Coresignal pricing (apiserpent)](https://apiserpent.com/blog/coresignal-pricing-explained)

**Email verification**

- [MillionVerifier](https://www.millionverifier.com/)
- [Verifier comparisons (StartupHub)](https://www.startuphub.ai/news/best-zerobounce-alternatives-email-verification)
- [ZeroBounce pricing (Emelia)](https://emelia.io/hub/zerobounce-preise)
- [Reoon vs ZeroBounce (TrustRadius)](https://tr-web.dev.trustradius.com/compare-products/reoon-email-verifier-vs-zerobounce)

**Signal tools**

- [TheirStack pricing](https://theirstack.com/fr/pricing)
- [BuiltWith vs Wappalyzer pricing (Prospeo)](https://prospeo.io/s/builtwith-vs-wappalyzer)
- [Wappalyzer pricing (derrick)](https://derrick-app.com/tools/wappalyzer-pricing)
- [RB2B pricing (Abmatic)](https://blog.abmatic.ai/rb2b-pricing)
- [Snitcher pricing (Warmly)](https://www.warmly.ai/p/blog/snitcher-pricing)
- [Leadfeeder free version](https://help.dealfront.com/en/articles/2694087-what-is-the-free-version-of-leadfeeder)
- [Product Hunt API notes (Rollout)](https://rollout.com/integration-guides/product-hunt/api-essentials)
- [Cert Spotter API v1](https://sslmate.com/certspotter/api/docs-v1)
- [crt.sh API notes](https://cert.imfht.com/crt-sh-api)
- [Apify LinkedIn scraper pricing](https://apiserpent.com/blog/apify-linkedin-scraper-pricing-explained)
- [Crunchbase API alternatives (Multiples)](https://multiples.vc/compare/crunchbase-api-alternatives)

**Registries and government data**

- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [Companies House rate limiting](https://developer-specs.company-information.service.gov.uk/guides/rateLimiting)
- [OpenCorporates pricing](https://opencorporates.com/pricing/)
- [SAM.gov API notes (Apify changelog)](https://apify.com/scrapebench/samgov-opportunity-alert/changelog)

**Data broker law**

- [California DROP for data brokers](https://privacy.ca.gov/drop-for-data-brokers/)
- [CPPA Delete Act regulations](https://cppa.ca.gov/announcements/2025/20251113.html)
- [Fenwick: Delete Act changes](https://www.fenwick.com/insights/publication/dont-drop-ball-upcoming-changes-california-delete-act-five-key-steps-companies)

**Live endpoint checks (curl, 2026-10-12)**

- **200:** Greenhouse, Lever, Ashby, SmartRecruiters, Google News RSS, SEC efts and data.sec.gov, USAspending, GitHub, r.jina.ai, DDG IA, Clearbit autocomplete.
- **429 (rate limit):** GDELT.
- **502:** crt.sh.
- **401 without key:** Companies House, OpenCorporates, logo.dev.
- **Connection failed:** logo.clearbit.com.
