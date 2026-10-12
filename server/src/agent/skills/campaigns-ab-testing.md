---
name: campaigns-ab-testing
description: A/B test campaign email variants and let Kinetic pick the winner automatically (or pick/reset by hand). Use when the user wants to compare subject lines or bodies, see which variant performs best, or configure auto-winner rules.
---
# A/B testing campaign steps (auto-winner)

Any sequence step can have variants (A = the main step, B, C… = its variants). Leads are split
evenly across the *active* variants, stable per lead. Spintax `{Hi|Hello}` and variables like
`{FIRST_NAME|there}` work in every variant as usual.

## 1. Create variants
Save the whole sequence with `PUT /api/campaigns/{id}/sequence`. Give a step a `variants` array
and an `ab_test` config:

```json
{
  "steps": [
    {
      "email_subject": "Quick question, {FIRST_NAME}",
      "email_body": "Hi {FIRST_NAME},\n\nDo you handle growth at {COMPANY}?",
      "variants": [
        { "email_subject": "Idea for {COMPANY}", "email_body": "{Hey|Hi} {FIRST_NAME|there}, quick idea for {COMPANY}." }
      ],
      "ab_test": { "enabled": true, "metric": "reply_rate", "min_sends_per_variant": 100, "reply_wait_days": 3, "confidence": 0.95, "pool": "all" }
    },
    { "email_subject": "", "email_body": "Bumping this up.", "wait_in_days": 3, "thread_reply": true }
  ]
}
```

- Always send every step (with its `id` and variant `id`s from `GET /api/campaigns/{id}/sequence`)
  when updating, or steps are replaced. Omitting `ab_test` (or `branching`) keeps what the step has; `null` clears it.
- The EmailBison v1.1 route `POST /api/campaigns/v1.1/{id}/sequence-steps` also accepts `ab_test` on main steps.

## 2. Config fields (`ab_test`)
| field | default | meaning |
|---|---|---|
| `enabled` | false | auto-pick a winner. Off = split evenly forever; compare by hand. |
| `metric` | `reply_rate` | `reply_rate`, `interested_rate`, `positive_reply_rate` (replies minus not-interested/unsubscribe/auto), `open_rate` (needs open tracking), `click_rate` (needs click tracking) |
| `min_sends_per_variant` | 100 | sends each variant needs before deciding |
| `reply_wait_days` | 3 | only sends at least this old count, so replies have time to arrive |
| `confidence` | 0.95 | required confidence (1 − p-value) |
| `pool` | `all` | `all` = test every lead until a winner; `percent` = test on `test_percent`% of leads, hold the rest at this step, then send them the winner |
| `test_percent` | 20 | share of leads in the test pool (percent mode) |

Change just the config: `PUT /api/campaigns/{id}/ab-tests/{stepId}` with any of these fields
(e.g. `{"metric": "interested_rate"}`); `stepId` may be the main step or any variant id. Open/click
metrics are rejected (422) while that tracking is off.

## 3. How the winner is decided
One-sided **two-proportion z-test** (pooled standard error) of the leading variant against every
other active variant; the largest p-value must be ≤ 1 − confidence, and every variant needs
`min_sends_per_variant` mature sends. Exact ties never decide. In `percent` mode, once the whole
test pool has passed the step and the reply wait is over, the leader is picked even if not
significant (a full tie keeps variant A) so held leads are never stuck. A background job checks every
5 minutes; `POST /api/campaigns/{id}/ab-tests/evaluate` checks now.

When decided: losing variants are switched off (`active=false`), their booked-but-unsent emails are
re-planned with the winner, the decision is stored with stats + p-value, and the `AB_TEST_WINNER`
webhook event fires.

## 4. Read results
`GET /api/campaigns/{id}/ab-tests` returns, per step with variants: `status` (`running` | `decided` |
`manual`), `reason` (why not decided yet, e.g. "Waiting for 100 sends…"), `p_value`, `winner_step_id`,
and `variants[]` with `letter`, `sent`, `opens`, `clicks`, `replies`, `interested`, `bounces`, each
`*_rate` (percent), `metric_rate`, `mature_sent`, `confidence` (0–1), `is_leader`, `is_winner`.
History: `GET /api/campaigns/{id}/ab-tests/decisions`.

## 5. Manual control (confirm with the user first — it changes who gets which email)
- Pick a winner: `POST /api/campaigns/{id}/ab-tests/{stepId}/pick-winner` `{"variant_id": 123}`.
- Undo/restart: `POST /api/campaigns/{id}/ab-tests/{stepId}/reset` — re-activates the variants the decision switched off.

## Pitfalls
- Don't recommend a winner from tiny samples; quote `confidence` and `reason`.
- Open rates are unreliable (Apple Mail, scanners); prefer reply or interested rate.
- Re-saving the sequence with `"active": true` on a losing variant turns it back on.
