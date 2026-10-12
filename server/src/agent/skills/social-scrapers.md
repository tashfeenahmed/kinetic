---
name: social-scrapers
description: Export Instagram, X/Twitter and Facebook audiences into a table with the Kinetic Companion extension — followers/following, profile data, hashtag posts, post likers/commenters, tweet likers/reposters, X search, Facebook group members, event attendees and page/profile basics.
---
# Instagram, X and Facebook scrapers

These run in the user's own logged-in browser via the Kinetic Companion extension (no passwords or cookies on the server). The user must be logged in to that network in the paired Chrome. Check `GET /api/companion/status` first.

## Phantoms
`GET /api/automations/phantoms` has the full input schema. Summary:

| phantom | params | key columns |
|---|---|---|
| `instagram.followers_export` | `targets` (profiles), `which`: followers \| following, `limit` | Username, Full name, Instagram URL, Private, Verified |
| `instagram.profile_scraper` | `targets` | Bio, Followers, Following, Posts, Website, Category, public Email/Phone |
| `instagram.hashtag_export` | `hashtag` (no #), `limit` | Post URL, Author, Caption, Likes, Comments |
| `instagram.post_engagers` | `targets` (posts), `which`: likers \| commenters, `limit` | Username, Comment, Post URL |
| `x.followers_export` | `targets` (profiles), `which`: followers \| following, `limit` | Username, Name, Bio, Followers, Location, Website |
| `x.profile_scraper` | `targets` | profile fields |
| `x.tweet_engagers` | `targets` (post URLs), `which`: likers \| retweeters, `limit` | users + Post URL (likers are only visible on the user's own posts) |
| `x.search_export` | `query` (X search syntax), `mode`: Latest \| Top, `limit` | Post URL, Text, Author, Likes, Reposts |
| `facebook.group_members` | `group_url`, `limit` | Name, Facebook URL, ID, Bio, Joined |
| `facebook.event_attendees` | `event_url`, `limit` | Name, Facebook URL |
| `facebook.page_scraper` | `targets` (pages/profiles) | Category, Likes, Followers, Website, Email, Phone, Address |

## Create
```
POST /api/automations/jobs
{"phantom": "instagram.followers_export", "name": "Followers of @acme",
 "params": {"targets": "https://www.instagram.com/acme/", "which": "followers", "limit": 1000},
 "table_name": "Instagram · acme followers"}
```
`targets` also accepts `{"table_id": 12, "column": "Instagram URL"}`. Add `"table_id"` to append to an existing table (deduped by username / URL). Data phantoms start right away; track with `GET /api/automations/jobs/:id`.

## Limits
Daily caps (configurable on Automations → Limits, `PUT /api/automations/settings`): Instagram 800 profiles/day, X 1,000/day, Facebook 500/day. Long exports continue the next day. Safety stops (rate limit, login wall, checkpoint) pause that network for the browser — tell the user rather than retrying.

## Pitfalls
- Private Instagram accounts and closed Facebook groups only work if the user can see them.
- Very large follower lists take days at safe pace; set a realistic `limit`.
- These scrape public-facing data only; never use them to collect data the user isn't allowed to see.
- For scheduled re-runs that add only new followers/posts, see `automations-watcher-mode`.
