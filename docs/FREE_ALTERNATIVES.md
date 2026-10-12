# kineticsand: free, self-coded alternatives to paid providers

*Compiled 2026-10-12. Builds on `RESEARCH.md` without repeating it. Tags as there: **[V]** = checked live today with curl/node from this Mac; **[3P]** = third-party/docs only; **[?]** = unverified.*

Goal: replace paid providers with code that runs inside the Node 24 server, with no Docker services, reading data files straight from GitHub raw URLs where possible.

---

## 0. Verdict table

| Need | Free replacement | Reliability | Build it? |
|---|---|---|---|
| Tech stack | `enthec/webappanalyzer` JSON + own matcher (or `wappalyzergo` single JSON) | High | **Yes** |
| Disposable / free-mail flags | `disposable-email-domains` + `Kikobeats/free-email-domains` raw lists | High | **Yes** |
| Email verification | Own SMTP RCPT probe (`node:net` + `node:dns`) with catch-all check | Medium (great on Google/M365/most self-hosted; useless on Yahoo/catch-alls) | **Yes**, port 25 is open here **[V]** |
| Email finding | Pattern inference from keyserver + GitHub commits + site crawl, then SMTP probe | Medium | **Yes** |
| Web search (no key) | Brave HTML scrape (works today), Bing RSS (no `site:`), Marginalia `public` key, Wiby | Low to medium; all ToS-grey or rate-limited | Only as a fallback behind Serper |
| SearXNG public JSON | Public instances return HTML or 429 for `format=json` **[V]** | Low | **No** (self-host only) |
| Common Crawl CDX | 504 on every query today **[V]**; few `linkedin.com/in` captures | Low | **No**; use Wayback CDX for slug checks |
| Company data | Wikidata SPARQL, GLEIF, yc-oss JSON | High | **Yes** |
| SEC headcount | `dei:EntityNumberOfEmployees` is **not in XBRL** for the filers tested (404) **[V]** | — | **No**; parse 10-K text instead |
| LLM | OpenRouter `:free` models (20 rpm, 50/day, or 1,000/day after $10 lifetime credits) **[V]**; Ollama local | Medium / High (local) | **Yes**, as a fallback tier |
| Mobile phones | None legitimate | — | **No** |
| Job-change detection | No free feed; DIY diff signals only | Low to medium | DIY only |

---

## 1. Tech-stack fingerprints

### 1.1 Sources (verified 2026-10-12)

| Repo | Last push | Stars | License | Data layout |
|---|---|---|---|---|
| **`enthec/webappanalyzer`** (recommended) | 2026-09-16 | 590 | GPL-3.0 | `src/technologies/{_,a..z}.json` (27 files), `src/categories.json`, `src/groups.json`, `schema.json` |
| `projectdiscovery/wappalyzergo` | 2026-10-11 | 1,116 | MIT (code) | One merged file, `fingerprints_data.json` (3.8 MB, `{"apps":{...}}`, **7,642 techs**), plus `categories_data.json` |
| `HTTPArchive/wappalyzer` | 2026-10-03 | 143 | GPL-3.0 | Same layout as the original (`src/technologies/a.json`…), smaller rule set |
| `dochne/wappalyzer` | 2024-11 (stale) | 288 | GPL-3.0 | Skip |
| npm `simple-wappalyzer` | 2026-09-17 (v1.1.106) | — | MIT | Node wrapper, if you'd rather not write the matcher |
| npm `wappalyzer`, `wappalyzer-core` | 2023 | — | — | Dead |

**Raw URLs (all HTTP 200 [V])**

```
https://raw.githubusercontent.com/enthec/webappanalyzer/main/src/technologies/_.json
https://raw.githubusercontent.com/enthec/webappanalyzer/main/src/technologies/{a..z}.json
https://raw.githubusercontent.com/enthec/webappanalyzer/main/src/categories.json
https://raw.githubusercontent.com/enthec/webappanalyzer/main/src/groups.json
https://raw.githubusercontent.com/enthec/webappanalyzer/main/schema.json
https://raw.githubusercontent.com/projectdiscovery/wappalyzergo/main/fingerprints_data.json
https://raw.githubusercontent.com/projectdiscovery/wappalyzergo/main/categories_data.json
```

The license is GPL-3.0 for the data. That's fine for a personal tool. Fetch the files at runtime rather than vendoring them into your repo if you ever distribute it.

### 1.2 Schema (field frequency in `a.json`, 572 techs)

`cats` 572, `website` 572, `icon`, `description`, `saas`, `pricing`, **`scriptSrc` 288, `js` 260, `dom` 139, `implies` 83**, `oss`, **`headers` 64, `scripts` 56**, `requires` 52, **`meta` 51**, `cpe`, **`html` 26, `cookies` 26, `dns` 16**, `xhr`, `url`, `excludes`, `requiresCategory`, `text`, `certIssuer`. The schema also defines `css`, `robots` and `probe`.

| Field | Type | Match against |
|---|---|---|
| `headers` | `{HeaderName: pattern}` | response headers (case-insensitive name) |
| `cookies` | `{name: pattern}` | `Set-Cookie` names/values |
| `meta` | `{name: pattern}` | `<meta name|property=… content=…>` |
| `html` | `pattern \| pattern[]` | raw HTML (deprecated upstream, still present) |
| `text` | `pattern[]` | visible text |
| `scriptSrc` | `pattern \| pattern[]` | `<script src>` URLs |
| `scripts` | `pattern \| pattern[]` | inline/external script **content** |
| `url` | `pattern[]` | page URL |
| `dns` | `{MX|TXT|NS|SOA|CNAME: pattern[]}` | DNS records (pairs well with the DoH approach in RESEARCH §1.6) |
| `certIssuer` | string | TLS cert issuer |
| `js` | `{"window.path": pattern}` | **needs a JS runtime** (headless browser); skip or approximate by regex on scripts |
| `dom` | `{selector: {exists, attributes, properties, text}}` or `selector[]` | DOM; `exists`/`attributes`/`text` work with cheerio, `properties` needs a browser |
| `implies` / `requires` / `excludes` / `requiresCategory` | name[] / cat id[] | post-processing |
| `cats` | int[] | keys of `categories.json` → `{name, groups[], priority}` |

**Pattern syntax:** a regex string plus optional `\;`-separated tags, e.g. `"^(.+)$\\;version:\\1\\;confidence:50"`. Split on `\;`. The first part is the regex (compile case-insensitive; an empty string means "exists"). `version:` uses `\1` back-references, with ternary `\1?a:b` support. `confidence:` defaults to 100.

**Matcher algorithm (about 200 lines of TS):** fetch the page with redirects; collect headers, cookies, HTML, script srcs, inline scripts and meta (cheerio); plus DNS MX/TXT. For each tech, test each field, sum confidence and resolve the version. Then apply `implies` recursively, drop techs whose `requires` aren't met, and apply `excludes`. Refresh the JSON weekly with an ETag check. A static fetch without a browser gets you roughly 70 to 80% of what the extension finds **[3P/?]**; `js` and `dom.properties` are the gap.

---

## 2. Disposable and free-mail lists

| List | Raw URL | Size | License | Updated |
|---|---|---|---|---|
| **disposable-email-domains/disposable-email-domains** (conservative, low false positives) | `https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf` | 9,880 lines **[V]** | CC0 **[V]** | 2026-10-12 |
| disposable/disposable-email-domains (aggressive) | `https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt` (also `domains_strict.txt`) | ~97k **[V]** | MIT | 2026-10-11 |
| 7c/fakefilter | `https://raw.githubusercontent.com/7c/fakefilter/main/txt/data.txt` | ~10.9k **[V]** | BSD-3 | 2026-10-12 |
| **Kikobeats/free-email-domains** (free + disposable merged, DNS-validated daily) | `https://raw.githubusercontent.com/Kikobeats/free-email-domains/master/domains.json` (JSON array) | ~33k **[V]** | MIT | 2026-10-12 |
| willwhite/freemail | `https://raw.githubusercontent.com/willwhite/freemail/master/data/free.txt` and `disposable.txt` | 4.5k free | ISC | stale (2024) |

Note: `allowlist.conf` no longer exists in the first repo (404).

**Recipe:** `isDisposable = set(disposable_email_blocklist.conf)`. `isFreeMail = set(Kikobeats) − isDisposable`, plus a hard-coded top 30 (gmail.com, googlemail.com, outlook.com, hotmail.*, live.*, yahoo.*, icloud.com, me.com, proton.me, protonmail.com, gmx.*, web.de, yandex.*, mail.ru, aol.com, zoho.com, …). Match the registrable domain and also its parents (`a.b.mailinator.com`). Refresh daily.

---

## 3. Email verification over SMTP

### 3.1 How the reference tools do it

**Reacher** (`reacherhq/check-if-email-exists`, Rust, 10.1k stars, pushed 2026-10-11; GitHub reports **MIT**, historically AGPL plus a commercial license, so check `LICENSE` if you copy code):

- **Provider routing by MX host** (`core/src/mx/mod.rs`):
  - Gmail/Workspace: `*.google.com.`
  - Microsoft B2C (hotmail/outlook.com): `*.olc.protection.outlook.com.`
  - Microsoft 365 B2B: other `*.protection.outlook.com.`
  - Yahoo: `*.yahoodns.net.`
  - Proofpoint: `*.pphosted.com.` / `ppe-hosted.com.`
  - Mimecast: `*.mimecast.com.`
- **Default method per provider** (`smtp/verif_method.rs`):
  - SMTP for Gmail, M365 B2B, Proofpoint, Mimecast and everything else.
  - **Headless** (WebDriver/chromedriver) for **Hotmail B2C**: the password-reset page `https://account.live.com/password/reset`.
  - **Headless** for **Yahoo**: the signup/recovery page. A non-browser "API" variant also exists: GET `https://login.yahoo.com/account/create?...` for cookies and the `acrumb`, then POST `https://login.yahoo.com/account/module/create?validateField=yid` with `{acrumb, sessionIndex, specId:"yidReg", userId}`. If the response has `IDENTIFIER_EXISTS`/`IDENTIFIER_NOT_AVAILABLE`, the address exists.
  - The Gmail HTTP trick (`HEAD https://mail.google.com/mail/gxlu?email=` and checking for `Set-Cookie`) is **deprecated** in the code. The M365 OneDrive trick (`HEAD https://{tenant}-my.sharepoint.com/personal/{user}_{domain}/_layouts/15/onedrive.aspx`, where 403 means exists) is marked `dead_code`. Don't build on either.
- **SMTP flow** (`smtp/connect.rs`):
  - Connect to MX:25 (SOCKS5 proxy optional).
  - `EHLO {hello_name}` (default `gmail.com`), then `MAIL FROM:<{from}>` (default `reacher.email@gmail.com`), with pipelining off.
  - **Catch-all first:** `RCPT TO:<{15 random alnum}@domain>`. If it's accepted, the domain is catch-all and the real address is reported deliverable/unknown.
  - Otherwise `RCPT TO:<target>`. A 2xx means deliverable. On error, the response text is classified (`smtp/parser.rs`):
    - Greylisted: `greylist|graylist|postgrey`, then retry on a new connection.
    - Disabled: `disabled|discontinued|inactive`.
    - Full inbox: `mailbox full|over quota|insufficient|out of storage`.
    - Invalid: `user unknown|no such user|does not exist|5.1.1|recipient rejected|mailbox unavailable|…` (about 45 phrases).
    - IP blacklisted: `spamhaus|blocked|poor reputation|dnsbl|…`.
    - A special case: "receiving mail at a rate that…" counts as deliverable.
  - `rules.json`: `SkipCatchAll` for gmail.com, hotmail.*, yahoo.*, and MX suffix `.antispamcloud.com.` (also 45s timeout).
  - Retries default to 1. A second connection is used to beat greylisting.

**AfterShip/email-verifier** (Go, MIT, pushed 2026-09-15, `smtp.go`):

- Dials **all MX hosts in parallel** and keeps the first that connects.
- For providers with an "API verifier" (Yahoo, `smtp_by_api.go`), it skips SMTP.
- Otherwise `HELO`, `MAIL FROM`, then RCPT on a random address for catch-all. If that's accepted, it returns `catch_all:true` and **doesn't test the real address**. If it's refused, it does RCPT on the real address, where `err == nil` means deliverable.
- Output: `{host_exists, full_inbox, catch_all, deliverable, disabled}`.
- Catch-all and SMTP checks are opt-in flags. Default timeouts are short.

### 3.2 Provider reality (2026)

| Provider (by MX) | RCPT result trustworthy? | Notes |
|---|---|---|
| Google (Gmail and Workspace) | **Yes.** Unknown users get `550-5.1.1 The email account that you tried to reach does not exist`. | Gmail is **not** "always accept". Workspace domains can turn on catch-all routing, which the random-address test detects. |
| Microsoft 365 B2B | Mostly yes (Directory-Based Edge Blocking returns `550 5.4.1 Recipient address rejected: Access denied`) | Some tenants accept everything (DBEB off), which the catch-all probe detects. |
| Outlook/Hotmail consumer | No (Reacher uses headless) | Needs a browser. **Skip**: mark as `unknown`. |
| Yahoo/AOL | **No, it accepts all RCPTs** | Needs the signup-form trick, which is fragile and ToS-violating. **Skip**: mark as `unknown`. |
| Proofpoint / Mimecast / Barracuda / antispamcloud | Often accept-all or tarpit | Long timeouts (45s); usually ends `catch_all`/`unknown`. |
| Self-hosted Postfix/Exim | Usually yes | Greylisting is common (`450 4.7.1 … greylisted`). Retry after 60 to 300 s. |

### 3.3 Pitfalls

- **Port 25 outbound:** blocked on most residential ISPs and on AWS, GCP, Azure, DigitalOcean and similar by default. **On this Mac it's open today**: `gmail-smtp-in.l.google.com:25` returned `220` and EHLO succeeded over **IPv6** **[V]**. Google is stricter on IPv6 sources without matching PTR, so prefer IPv4 (`family: 4`) if you see `550-5.7.1 … PTR` errors.
- **Reputation:** use a real `EHLO` name you control and whose A/PTR resolves. Use a `MAIL FROM` on a domain with SPF. Residential IPs are on Spamhaus PBL, and some MXs reject at connect (`554 … PBL`). Classify that as `unknown`, **not** `invalid`.
- **Rate:** at most 1 connection per MX at a time, about 20 to 30 RCPTs per connection at most, and a few hundred checks per day per IP. Bursts get you tarpitted or blocklisted. Cache per-domain catch-all status for 30 days.
- **Never send `DATA`.** `RSET` between probes, then `QUIT`.
- **STARTTLS:** not needed for RCPT probing. A few servers require it before `MAIL`; upgrade with `tls.connect({socket, servername})` if `530 5.7.0 Must issue STARTTLS`.

### 3.4 Node algorithm (`node:dns/promises`, `node:net`, `node:tls`)

```
verify(email):
  syntax check; lowercase domain; punycode (url.domainToASCII)
  if disposable(domain) -> {result:'disposable'}
  mx = await dns.resolveMx(domain) sorted by priority; if none -> try A record (implicit MX); if none -> 'invalid'(no_mx)
  provider = classify(mx[0].exchange)       // google | m365 | outlook_b2c | yahoo | proofpoint | mimecast | other
  if provider in (yahoo, outlook_b2c) -> 'unknown'(provider_blocks_smtp)   // unless you add the headless path
  cached = catchAllCache.get(domain)
  for host in mx (max 2):
    sock = net.connect({host, port:25, family:4, timeout:15000 (45000 for proofpoint/mimecast/antispamcloud)})
    read multi-line replies (lines "ddd-..." continue, "ddd ..." ends)
    expect 220; send "EHLO {HELO_NAME}" -> 250 (fall back to HELO on 5xx)
    if 530 STARTTLS later: upgrade via tls.connect({socket:sock, servername:host}) and re-EHLO
    "MAIL FROM:<{FROM}>" -> 250 else classify (blocked -> 'unknown')
    if cached === undefined:
        r = RCPT "<{random 16 [a-z0-9]}@domain>"
        catchAll = r.code in 2xx; cache 30d
    if catchAll -> QUIT; return 'catch_all' (risky)
    "RSET"; "MAIL FROM" again; r = RCPT "<email>"
    250/251 -> 'valid'
    550/551/553 + invalid phrase or 5.1.1/5.1.0/5.1.10 -> 'invalid'
    552/452 + quota phrase -> 'full_inbox'; disabled phrase -> 'disabled'
    450/451/421 or greylist phrase -> schedule retry in 5 min (max 2) -> else 'unknown'(greylisted)
    blacklist/PBL phrase or connect refused/timeout -> try next MX -> else 'unknown'
    always "QUIT"
```

Output shape to store: `{email, result: valid|invalid|catch_all|unknown|disposable, mx, provider, smtp:{code, enhanced, message}, catchAll, checkedAt}`.

---

## 4. Email finding without paid APIs

### 4.1 What theHarvester does (laramies/theHarvester, GPL-2.0, pushed 2026-10-07)

Its email sources are **search-engine scrapes**: `yahoosearch` (`search.yahoo.com/search?p=%40{domain}`), `baidusearch`, `duckduckgosearch` (IA API only, so near-useless), `mojeek` (scrapes if no key), `bravesearch` (needs a key), `huntersearch`, `intelx`, `tomba`, `rocketreach` and `dehashed` (all keyed). Keyless modules are mostly **subdomain** sources: crtsh, certspotter, rapiddns, commoncrawl, waybackarchive, otx, robtex, sourcegraph and others. In practice, keyless theHarvester email yield in 2026 is low. Yahoo timed out and Mojeek and DDG served captchas from here **[V]**. Copy the *ideas*, not the scrapers.

### 4.2 Free sources that work today

| Source | Endpoint | Shape | Verdict |
|---|---|---|---|
| **PGP keyserver (Hockeypuck)** | `GET https://keyserver.ubuntu.com/pks/lookup?search={domain}&op=index&options=mr` | Text: `pub:{fpr}:…` / `uid:{Name} <{email}>:{created}::` **[V]**. `stripe.com` returned 100 keys with real `first@stripe.com` addresses. | **Yes.** It's the best free pattern seed. Data is old, so use it for the *pattern*, not for current people. `keys.openpgp.org` only does exact `vks/v1/by-email/{email}` (no domain search). |
| **GitHub commit search** | `GET https://api.github.com/search/commits?q=author-name:"First Last"&per_page=100` (also `author-email:full@addr`, `committer-email:`, `org:{org}`) | `items[].commit.author{name,email,date}`, `items[].repository.full_name` **[V]**. `author-email:@domain` returns 0, so **no domain wildcard**. | **Yes.** Search API: 10 req/min unauthenticated, 30/min with a PAT. Filter out `@users.noreply.github.com`. |
| GitHub org repo commits | `GET https://api.github.com/repos/{org}/{repo}/commits?per_page=100` → `[].commit.author.email`; or `https://github.com/{o}/{r}/commit/{sha}.patch` (`From:` line, not counted against the API) | | **Yes** for tech companies: harvest `*@company.com` authors to learn the pattern. Core API is 60/hr unauthenticated (it hit 0 during testing); use a PAT (5,000/hr). |
| **Website crawl** | Fetch `/`, `/contact`, `/about`, `/team`, `/imprint`/`/impressum`, `/legal`, `/privacy`, `/press`, `sitemap.xml` (via `r.jina.ai` or direct) | Regex `[A-Za-z0-9._%+-]+@domain` plus de-obfuscation (`[at]`, `(dot)`, `mailto:`, Cloudflare `data-cfemail` XOR decode) | **Yes**, often yields role addresses plus 1 or 2 personal ones. |
| Wayback CDX | `GET https://web.archive.org/cdx/search/cdx?url={domain}/team*&output=json&fl=original,timestamp&collapse=urlkey` then `https://web.archive.org/web/{ts}id_/{url}` | JSON array of arrays **[V]** | Good for old team/contact pages. |
| Sourcegraph | `https://sourcegraph.com/.api/search/stream?q="@{domain}" type:file count:100` (SSE) | Code hits | Optional; useful for dev companies. |

### 4.3 Pattern inference

1. Collect `(name?, email)` samples at the domain from the sources above.
2. Map each sample to a template: `{first}`, `{last}`, `{f}{last}`, `{first}.{last}`, `{first}{l}`, `{first}_{last}`, `{last}.{first}`, `{f}.{last}`, `{first}-{last}`.
3. Score each template by count, with recency weighting (keyserver uid created-time, commit date).
4. If there are no samples, use priors: `first` (small firms), `first.last` (larger or EU firms), `flast`.
5. Generate the top 3 candidates for the person (ASCII-fold diacritics, strip hyphens and apostrophes).
6. SMTP-probe in order (§3.4). Stop at the first `valid`. If the domain is `catch_all`, return the top pattern with `confidence = pattern_score`, marked "risky".

---

## 5. Free web search without API keys (tested from this Mac, 2026-10-12)

| Engine | Request | Result **[V]** | Verdict |
|---|---|---|---|
| **SearXNG public instances** | `GET https://{inst}/search?q=…&format=json` | List: `https://searx.space/data/instances.json` (94 instances, 29 with ≥90% success). Of 25 tested: **0 returned JSON**. 14 returned 429, 6 returned 403/418, and 5 returned 200 but **HTML** (JSON format disabled or a bot check). | **Unusable.** JSON is off by default (`search.formats`) and the limiter blocks bots. Self-hosting is possible without Docker (`pip install` from git, enable `json` in `settings.yml`), but it's a Python service. |
| **Brave HTML** | `GET https://search.brave.com/search?q=…&source=web` with a browser UA | **200 with real results**, e.g. `linkedin.com/in/...` URLs for "stripe cto linkedin" | Works today. ToS-prohibited and will captcha under volume. Fallback only, at most ~1 request per 10 s. |
| Bing RSS | `GET https://www.bing.com/search?q=…&format=rss` | 200 XML `<item><title><link><description>`, **but `site:` is ignored** | Fallback for generic queries only. |
| Bing HTML | `/search?q=site:linkedin.com/in …` | No LinkedIn results | No. |
| DuckDuckGo html/lite | `html.duckduckgo.com/html/?q=` | **202 "anomaly" captcha** | No. |
| Startpage | `/sp/search?query=` | captcha | No. |
| Mojeek | HTML: `<title>Captcha`. API `api.mojeek.com/search?…&fmt=json`: 403 without a key (paid). | | No. |
| Yahoo | `search.yahoo.com/search?p=` | timeout | No. |
| **Marginalia** | New: `GET https://api2.marginalia-search.com/search?query=…&count=20` with header `API-Key: public`. Old: `https://api.marginalia.nu/public/search/{q}?count=` | `public` key returned "QPM Limit Exceeded" and the old API returned 504. Free non-commercial key by email (CC-BY-NC-SA). | Indie/small-web index. **Useless for company/people lookups.** |
| Wiby | `GET https://wiby.me/json/?q=…` | 200 `[{URL, Title, Snippet}]` | Retro-web index; useless here. |
| **Common Crawl CDX** | `GET https://index.commoncrawl.org/CC-MAIN-2026-39-index?url=…&output=json` (latest IDs from `/collinfo.json`: `CC-MAIN-2026-39`, `-34`, `-30`) | `collinfo.json` 200, but **every index query 504'd** (two crawls, four queries). LinkedIn's robots.txt also limits CCBot. | **No** for LinkedIn discovery. The columnar index (Parquet on `data.commoncrawl.org`, queryable with DuckDB) is the only robust route, and it's heavy. |
| **Wayback CDX** | `GET https://web.archive.org/cdx/search/cdx?url=linkedin.com/in/{slug}*&output=json&fl=original,timestamp` | 200 **[V]** | Checks whether a guessed slug exists or existed (prefix enumeration). It's not name search. |

**Bottom line:** there's no reliable keyless SERP in 2026. Keep Serper (2,500 free) / Exa / Tavily free tiers from RESEARCH §2.3 as primary, with Brave HTML as an emergency fallback.

---

## 6. Free company data

### 6.1 Wikidata SPARQL **[V]**

`GET https://query.wikidata.org/sparql?query={urlencoded}` with `Accept: application/sparql-results+json` and a descriptive `User-Agent`. CC0, 60 s timeout.

Property IDs (labels verified via `wbgetentities`):

| Property | ID | Property | ID |
|---|---|---|---|
| official website | **P856** | legal form | P1454 |
| LinkedIn company ID | **P4264** | Crunchbase org ID | **P2088** |
| employees | **P1128** (qualifier P585 = point in time) | LEI | **P1278** |
| inception | **P571** | SEC CIK | **P5531** |
| industry | **P452** | ticker | **P249** (usually a *qualifier* on P414 stock exchange) |
| HQ location | **P159** | X username / Facebook | P2002 / P2013 |

Lookup by domain (the website value varies in `www`, scheme and trailing slash, so try variants):

```sparql
SELECT ?c ?cLabel ?li ?emp ?inception ?industryLabel ?hqLabel ?cb ?lei ?cik WHERE {
  VALUES ?w { <https://stripe.com/> <https://stripe.com> <https://www.stripe.com/> <https://www.stripe.com> }
  ?c wdt:P856 ?w .
  OPTIONAL{?c wdt:P4264 ?li} OPTIONAL{?c wdt:P1128 ?emp} OPTIONAL{?c wdt:P571 ?inception}
  OPTIONAL{?c wdt:P452 ?industry} OPTIONAL{?c wdt:P159 ?hq} OPTIONAL{?c wdt:P2088 ?cb}
  OPTIONAL{?c wdt:P1278 ?lei} OPTIONAL{?c wdt:P5531 ?cik}
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 20
```

The result for Stripe (Q7624104) was `li=stripe`, `emp=2500|8000` (several statements), `inception=2010`, `cb=stripe`, `lei=549300CLHGIPTCYHQ143`, `hq=San Francisco` **[V]**. To get the *latest* headcount, use `p:P1128 ?st . ?st ps:P1128 ?emp ; pq:P585 ?date` and `ORDER BY DESC(?date)`. Shape: `results.bindings[].{var:{type,value}}`. Coverage is good for notable companies and poor for startups.

### 6.2 GLEIF **[V]**

- By LEI (best, chained from Wikidata P1278): `GET https://api.gleif.org/api/v1/lei-records/{LEI}`
- Name search: `GET https://api.gleif.org/api/v1/lei-records?filter[fulltext]={name}&page[size]=10`. `filter[entity.legalName]=` is fuzzy-ish and returned "ACCENT STRIPE, INC." first for "Stripe, Inc.".
- Autocomplete: `GET https://api.gleif.org/api/v1/autocompletions?field=fulltext&q={q}` returns `data[].attributes.value` plus `relationships.lei-records.data.id`.
- Shape: `data[].id` (LEI), `attributes.entity.{legalName.name, legalAddress, headquartersAddress, jurisdiction, legalForm, status}`, `relationships.{direct-parent, ultimate-parent}`.
- No key. CC0. Rate limit about 60/min **[3P]**.

### 6.3 YC companies (`yc-oss/api`, pushed daily, last update 2026-10-12T03:23Z **[V]**)

- All companies: `https://yc-oss.github.io/api/companies/all.json` (10.6 MB, **6,288 companies** **[V]**).
- Index: `https://yc-oss.github.io/api/meta.json`.
- Subsets: `/batches/{season-year}.json` (e.g. `fall-2026`), `/industries/{slug}.json`, `/tags/{slug}.json`, `/companies/top.json`, `/companies/hiring.json` **[3P]**.
- Fields: `id, name, slug, former_names, website, all_locations, one_liner, long_description, team_size, industry, subindustry, industries, regions, tags, launched_at, batch, status, stage, isHiring, top_company, nonprofit, url, api`.
- No LICENSE file (the data is scraped from YC's Algolia index). Fine for personal use.

### 6.4 Other open startup and company data

- **OpenCorporates alternatives:** go direct to registries (RESEARCH §2.5), plus GLEIF. There's no free global aggregate.
- **Wikidata dumps** are the bulk version of §6.1.
- **SEC headcount: correction to RESEARCH §1.5.** `GET https://data.sec.gov/api/xbrl/companyconcept/CIK{10}/dei/EntityNumberOfEmployees.json` returned **404** for Apple, Alphabet and Tesla. The `frames` endpoint returned 404 for CY2023 to CY2025. Apple's `companyfacts` `dei` contains only `EntityCommonStockSharesOutstanding` and `EntityPublicFloat` **[V]**. US filers put headcount in 10-K Item 1 ("Human Capital") **text**. Get it from `data.sec.gov/submissions/CIK{10}.json`, find the latest 10-K `primaryDocument`, fetch it from `https://www.sec.gov/Archives/edgar/data/{cik}/{accession-no-dashes}/{doc}`, then regex/LLM `approximately ([\d,]+) (full-time )?employees`.

---

## 7. Free LLMs

### 7.1 OpenRouter `:free` (live `GET https://openrouter.ai/api/v1/models`, 458 models, 19 free **[V]**)

| Slug | Context | Tools | JSON/structured |
|---|---|---|---|
| `openrouter/free` (router across free models) | 200k | ✓ | ✓ |
| `google/gemma-4-31b-it:free` | 262k | ✓ | ✓ |
| `google/gemma-4-26b-a4b-it:free` | 262k | ✓ | ✓ |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262k | ✓ | ✓ |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1M | ✓ | — |
| `nvidia/nemotron-3.5-lightning:free` | 1M | ✓ | — |
| `thinkingmachines/inkling:free`, `inkling-small:free` | 1M | ✓ | — |
| `dots-studio/dots-3-note-preview:free` | 512k | ✓ | ✓ |
| `apodex/apodex-1.1-mini:free` | 262k | ✓ | ✓ |
| `poolside/laguna-s-2.1:free`, `laguna-xs-2.1:free` | 262k | ✓ | — |
| `cohere/north-mini-code:free` | 256k | ✓ | — |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256k | ✓ | — |
| `liquid/lfm-2.5-2.6b:free` | 65k | ✓ | ✓ |

Price-zero entries without a `:free` suffix (`google/lyria-3-*`, which are music models; `inclusionai/ling-3.1-flash`; `nvidia/nemotron-3.5-content-safety:free`) aren't useful for extraction.

**Limits (from the docs page constants [V]):** `FREE_MODEL_RATE_LIMIT_RPM=20`, `FREE_MODEL_NO_CREDITS_RPD=50`, `FREE_MODEL_HAS_CREDITS_RPD=1000` with `FREE_MODEL_CREDITS_THRESHOLD=10`. That means 20 req/min, and 50/day until you've bought $10 of credits lifetime, then 1,000/day. Free providers may log or train on prompts. The list churns monthly, so resolve slugs at boot from `/models` (filter `id.endsWith(':free')`) instead of hard-coding them.

Same request shape as paid: `POST https://openrouter.ai/api/v1/chat/completions` with `{model, messages, response_format:{type:"json_schema",json_schema:{...}}}`.

### 7.2 Ollama (installed here at `/opt/homebrew/bin/ollama`; the server wasn't running during the check)

- OpenAI-compatible: `POST http://localhost:11434/v1/chat/completions` (any bearer, e.g. `ollama`), `GET /v1/models`.
- Native: `POST http://localhost:11434/api/chat` with `{model, messages, format:<JSON schema>, stream:false}`, which gives grammar-constrained JSON. That's more reliable for extraction than `/v1`'s `response_format`.
- Start with `ollama serve` (a brew service, not Docker). Pull e.g. `ollama pull gemma3:12b` or a Qwen/Gemma 7 to 14B model for extraction on Apple Silicon.

**Tiering:** Ollama (free, unlimited, private) → OpenRouter `:free` (rate-limited) → `anthropic/claude-haiku-5.5` (paid, for hard cases).

---

## 8. Mobile phones and job-change detection

- **Mobile phones: no legitimate free source exists (confirmed).** Every mobile dataset is a broker/waterfall product (RESEARCH §2.1/§3.2). Free sources only give **business switchboard** numbers:
  - website contact/imprint pages (EU imprints legally require a phone)
  - Wikidata P1329 (phone number)
  - OSM/Overture `phone` tags
  - SEC filing cover pages, GLEIF (no phone), Companies House (no phone)

  Scraping personal mobiles from leak or "people search" sites is illegal or ToS-violating. Don't.
- **Job change: no free feed (confirmed).** DIY signals you can code:
  1. Re-run your own email SMTP probe every 60 days. `valid → invalid` on a previously valid, non-catch-all address is a strong "left company" signal, and it's free given port 25.
  2. Diff the company's team/leadership page (website watcher, RESEARCH §1.7).
  3. Diff the GitHub user `company`/`bio` field (`GET https://api.github.com/users/{login}`).
  4. Google News RSS for `"{name}" (joins OR appointed OR hires)`.
  5. SEC 8-K Item 5.02 for public-company executives.
  6. Wayback CDX timestamps on a known LinkedIn slug don't reveal content; LinkedIn pages archived after 2023 are mostly authwall.

  Paid detectors (LeadMagic, 3 credits) remain the only direct feed.

---

## 9. Build order (free adapters)

1. `techstack`: webappanalyzer JSON + cheerio matcher + DoH `dns` rules.
2. `emailFlags`: disposable/free-mail sets (daily refresh).
3. `smtpVerify`: §3.4, with a per-domain catch-all cache and a global concurrency of 2 to 4.
4. `emailPattern`: keyserver + GitHub commits + site crawl → template scoring → `smtpVerify`.
5. `wikidata` + `gleif` + `ycoss`: firmographics.
6. `llm`: provider chain Ollama → OpenRouter `:free` → Haiku.

Keep Serper/Exa (free tiers) for search. There's no free replacement worth coding.

## 10. Sources

- github.com/enthec/webappanalyzer, github.com/projectdiscovery/wappalyzergo, github.com/HTTPArchive/wappalyzer
- github.com/disposable-email-domains/disposable-email-domains, github.com/disposable/disposable-email-domains, github.com/7c/fakefilter, github.com/Kikobeats/free-email-domains, github.com/willwhite/freemail
- github.com/reacherhq/check-if-email-exists (`core/src/smtp/*.rs`, `core/src/mx/mod.rs`, `core/src/rules.json`), github.com/AfterShip/email-verifier (`smtp.go`)
- github.com/laramies/theHarvester (`theHarvester/discovery/*.py`, `data/api-keys.yaml`)
- searx.space/data/instances.json, about.marginalia-search.com/article/api/, wiby.me/json, index.commoncrawl.org, web.archive.org/cdx
- keyserver.ubuntu.com, keys.openpgp.org/about/api, docs.github.com/rest/search#search-commits
- query.wikidata.org, api.gleif.org, yc-oss.github.io/api, data.sec.gov
- openrouter.ai/api/v1/models, openrouter.ai/docs/api/reference/limits, github.com/ollama/ollama/blob/main/docs/openai.md
