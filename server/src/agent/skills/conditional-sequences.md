---
name: conditional-sequences
description: Build branching campaign sequences — "if not opened go to step 3", "if title contains CEO move to another campaign", tag/end/wait/skip rules — and inspect which path each lead took. Use when the user wants conditions, branches or different follow-ups per lead behaviour.
---
# Conditional (branching) sequences

Rules hang off a step ("after this step…") in its `branching` field. They are checked when the
lead's **next step is due** (after the next step's `wait_in_days`; for the last step, after
`check_after_days`, default 3). The first matching rule's action runs; otherwise `else` (default
`continue`). A step without rules is linear, exactly as before. Stop-on-reply still applies first:
with it on, replying leads stop and are never branched.

## Shape
```json
"branching": {
  "rules": [ { "when": [ <condition>, ... ], "match": "all" | "any", "then": <action> } ],
  "else": { "type": "continue" },
  "check_after_days": 3,
  "max_visits": 3
}
```
`max_visits` (default 3) is the loop guard: how often *this* step may be sent to one lead; a branch
into a step that hit its limit ends the sequence for that lead.

Conditions (full catalogue with examples: `GET /api/sequence-conditions`):
- `{"type":"opened","negate":true}` — not opened the previous email (`"scope":"any"` = any email so far). Needs open tracking.
- `{"type":"clicked","url":"pricing"}` — clicked (optionally a link containing text). Needs click tracking.
- `{"type":"replied"}` / `{"type":"replied","negate":true}` — only useful with stop-on-reply off.
- `{"type":"reply_category","value":"interested"|"not_interested"}` — latest human reply, or the reply a reply-follow-up campaign answers.
- `{"type":"lead_field","field":"title","op":"contains","value":"CEO"}` — ops: equals, not_equals, contains, not_contains, empty, not_empty, gt, lt. Fields: email, first_name, last_name, title, company, notes, domain, or any custom variable name.
- `{"type":"email_provider","value":"google"|"microsoft"|"other"}` — from the lead domain's MX (cached; lookup happens in the background, the lead waits a minute the first time).
- `{"type":"has_tag","tag":"VIP"}` (`negate` for "does not have").
- `{"type":"day_of_week","days":["friday"]}` — campaign timezone.
- `{"type":"time_since_previous","op":"gt","days":5}`.

Actions:
- `{"type":"continue"}` — next step. `{"type":"jump","step":3}` — send step 3 now.
- `{"type":"skip"}` — skip the next step (go to the one after).
- `{"type":"wait","days":2}` — wait 2 more days, then send the next step (rules aren't re-checked).
- `{"type":"end"}` — finish the sequence for this lead.
- `{"type":"move","campaign_id":12}` — finish here and add the lead to campaign 12 (from step 1).
- `{"type":"add_tag","tag":"Clicked pricing"}` — tag the lead, then continue.
A jump/skip sends its target right away (the wait was already served); add a `wait` rule for more time.

## Example: create a sequence with variants and conditions
`PUT /api/campaigns/{id}/sequence`
```json
{
  "steps": [
    {
      "email_subject": "{Quick|Short} question, {FIRST_NAME}",
      "email_body": "Hi {FIRST_NAME}, do you own outbound at {COMPANY}?",
      "variants": [{ "email_subject": "Idea for {COMPANY}", "email_body": "Hey {FIRST_NAME|there}, quick idea for {COMPANY}." }],
      "ab_test": { "enabled": true, "metric": "reply_rate" },
      "branching": {
        "rules": [
          { "when": [{ "type": "lead_field", "field": "title", "op": "contains", "value": "CEO" }], "then": { "type": "move", "campaign_id": 12 } },
          { "when": [{ "type": "opened", "negate": true }], "then": { "type": "jump", "step": 3 } }
        ],
        "else": { "type": "continue" }
      }
    },
    { "email_subject": "", "email_body": "Saw you opened my note — worth a chat?", "wait_in_days": 2, "thread_reply": true },
    { "email_subject": "Different angle", "email_body": "Trying a new subject in case the first got buried.", "wait_in_days": 3,
      "branching": { "rules": [{ "when": [{ "type": "clicked" }], "then": { "type": "add_tag", "tag": "Engaged" } }], "else": { "type": "end" } } }
  ]
}
```
Same fields work on `POST /api/campaigns/v1.1/{id}/sequence-steps` (on non-variant steps). To change
one step's rules only: `PUT /api/campaigns/{id}/sequence/steps/{stepNumber}/branching` with the
`branching` object as the body (empty `rules` + `continue` = linear again).

## Check before launching
`GET /api/campaigns/{id}/branching/check` (also part of `GET /api/campaigns/{id}/launch-check`):
`problems` (block launch: jumps to missing steps, moves to missing campaigns) and `warnings`
(unreachable steps, self-loops, open/click conditions with tracking off, reply conditions with
stop-on-reply on). Fix problems before `POST /api/campaigns/{id}/launch`.

## Inspect paths
- One lead: `GET /api/campaigns/{id}/leads/{leadId}/path` → `timeline` of `sent` (step, variant, opened/clicked/replied), `branch` (from_step, rule_index or null for else, `description`, `reason`) and `reply` events, plus `next_step`/`next_due_at`.
- Whole campaign: `GET /api/campaigns/{id}/branching/stats` → leads per step/rule/target.
- Provider lookup: `POST /api/email-provider/lookup` `{"emails":["jane@acme.com"]}`.

## Pitfalls
- Step numbers in `jump` are positions; deleting/reordering steps shifts them — re-check after edits.
- Confirm with the user before launching or changing rules on a live campaign (it changes who gets which email).
