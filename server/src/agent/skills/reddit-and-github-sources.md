---
name: reddit-and-github-sources
description: Pull Reddit posts, commenters, user activity and search results, GitHub stargazers/contributors/org members, and Hacker News launches, "Who is hiring" companies and people asking for a tool, into a table — server-side, no browser extension needed.
---
# Reddit, GitHub and Hacker News sources (server-side)

These phantoms run on the Kinetic server against public APIs, so they work without the Companion extension and at any hour.

## Reddit (public JSON endpoints)
| phantom | params |
|---|---|
| `reddit.subreddit_posts` | `subreddit` ("sales" or "r/sales"), `sort`: new \| hot \| top \| rising, `time` (for top): day…all, `limit` (≤1000) |
| `reddit.search` | `query`, optional `subreddit`, `sort`: new \| relevance \| top \| comments, `limit` |
| `reddit.post_commenters` | `targets`: post URLs | 
| `reddit.user_activity` | `targets`: user URLs or usernames → karma, account age, subreddits they're active in, recent activity |

```
POST /api/automations/jobs
{"phantom": "reddit.search", "name": "People asking for a CRM",
 "params": {"query": "\"looking for\" crm", "subreddit": "smallbusiness", "sort": "new", "limit": 100},
 "schedule": {"every": "daily"}, "alerts": {"slack": true}}
```
Columns: Title, Author, Author URL, Subreddit, Post URL, Link, Score, Comments, Flair, Text, Posted. Commenters: Author, Comment, Score, Comment URL.
Reddit rate-limits unauthenticated clients (~10 requests/minute); big exports take a few minutes. Deleted authors appear as "[deleted]".

## GitHub
| phantom | params |
|---|---|
| `github.stargazers` | `repo` ("owner/repo" or URL), `limit` — newest stargazers first |
| `github.contributors` | `repo`, `limit` — by commit count |

Each person is enriched with their public profile (name, company, email if public, location, website, X). Without a `GITHUB_TOKEN` (free, Integrations page) GitHub allows 60 requests/hour — enough for ~50 people. With a token: 5,000/hour.

GitHub **org members** are a table source rather than a phantom: `POST /api/gtm/tables/:id/import/source {"source": "github_people", "params": {"org": "vercel"}, "limit": 50}`.

## Hacker News (free Algolia HN API)
A table source (`hacker_news`), so it works in imports and saved searches: `POST /api/gtm/tables/:id/import/source {"source": "hacker_news", "params": {"mode": "launches", "keywords": "crm, analytics", "days": 30}, "limit": 100}`.
| mode | what you get |
|---|---|
| `launches` (default) | Show HN / Launch HN posts: Company, Company domain (from the post link), Link, Title, Author, Points, Comments, Posted, HN URL. Optional `min_points`. |
| `hiring` | Top-level posts in the latest `months` (default 1) "Who is hiring?" threads matching `keywords` (or all): Company, Company domain, Roles, Location, Remote, Post. |
| `intent` | Ask HN posts and comments in the last `days` that mention a keyword and a buying phrase ("looking for a", "alternatives to", "recommend"…, override with `phrases`): Author, Text, Phrase, Thread, HN URL. `keywords` required. |
Watch it daily with a saved search (`saved-searches-and-watchers`, source `hacker_news`) to get only new posts. For HN mentions of companies already in a table, use the Hacker News signal column instead.

## Follow up
- Progress and runs: `GET /api/automations/jobs/:id`; results land in `/tables/{table_id}`.
- Then enrich (work email from GitHub commits, company data) with table columns, or schedule the job (`automations-watcher-mode`) to collect only new posts/stargazers.
