---
name: enrich-emails-and-phones
description: Use to find and verify work emails, mobile phones, LinkedIn URLs or company domains for rows in a table — explains each enrichment waterfall, required inputs, free vs paid providers and costs.
---
# Enrich emails, phones and profiles

Enrichment columns run a provider waterfall and stop at the first confident hit. Free steps come first; paid steps run only when their API key is set (Integrations page). Check what's ready with `GET /api/gtm/catalog` → `enrich[].steps[].ready` and `cost`.

## Add a column — `POST /api/gtm/tables/{id}/columns`
| kind | needs (any one group) | notes |
|---|---|---|
| `work_email` | fullName+domain, firstName+domain, fullName+companyName, linkedinUrl | free finder (website + GitHub commit patterns + SMTP check) → MillionVerifier pattern → Icypeas → Findymail → Prospeo → LeadMagic → Hunter → Apollo → PDL → pattern guess (unverified) |
| `verify_email` | email | free SMTP check → MillionVerifier → ZeroBounce → Hunter → MX check. Value: valid, catch_all, risky, invalid, unknown |
| `mobile_phone` | linkedinUrl, email, fullName+domain | paid only (LeadMagic, Findymail, Prospeo, PDL). No free source — tell the user |
| `linkedin_url` | fullName, firstName+lastName, email | free web search first |
| `person_profile` | email, linkedinUrl, fullName+domain/companyName | Apollo / PDL only |
| `company_domain` | companyName | YC, Wikidata, Apollo, web search |
| `company_profile` | domain or companyName | YC, Wikidata, Apollo, PDL, Hunter, website scrape |
| `company_linkedin` | companyName or domain | Wikidata, website footer, search |

Example:
```json
{ "name": "Work email", "type": "enrich", "auto_run": true,
  "config": { "kind": "work_email", "inputs": { "fullName": "{{Full name}}", "domain": "{{Company domain}}" } } }
{ "name": "Email status", "type": "enrich", "auto_run": true,
  "config": { "kind": "verify_email", "inputs": { "email": "{{Work email}}" } } }
{ "name": "Mobile", "type": "enrich", "config": { "kind": "mobile_phone", "inputs": { "linkedinUrl": "{{LinkedIn URL}}" } } }
```
- Limit or reorder providers with `"providers": ["free_finder", "icypeas", "pattern"]` (step ids from the catalog).
- If the table has only a company name, add `company_domain` first and feed `{{Company domain}}` onward.
- Split full names with formulas if needed: `first(row["Full name"])`, `last(row["Full name"])`.

## Run
`POST /api/gtm/tables/{id}/run` `{ "columnIds": [<email col>, <verify col>] }`. Verification re-runs automatically when the email fills in.
- **Cost:** before running paid providers on many rows, tell the user roughly what it costs (catalog `cost` per lookup × rows). Over ~100 rows with paid steps ready, the run pauses for approval.
- The free finder and SMTP verifier need outbound port 25; if results are all `unknown`, suggest `POST /api/gtm/keys/test/smtp` or a paid verifier key.

## Read results
`GET /api/gtm/tables/{id}` → each cell `{ value, status: done|empty|skipped|error, provider }`. Count valid emails before moving to outreach; `skipped` with "Missing input" means a referenced column is blank or misnamed. Use `GET /api/gtm/cells/{rowId}/{columnId}` to see which providers were tried.
