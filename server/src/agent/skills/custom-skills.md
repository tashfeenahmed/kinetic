---
name: custom-skills
description: Create, update or delete the workspace's own agent skills (markdown playbooks) — save a workflow the user liked ("remember how we built the funded-tech list"), the user's house rules for copy or targeting, or a step-by-step process — and list the built-in and custom skills. Use when the user says "remember this", "always do X when…", "make this a skill".
---
# Custom skills

Skills are markdown instructions the agent loads with `load_skill`. Built-in skills are read-only; custom skills belong
to the workspace and appear in `list_skills` for every later chat.

- List: `GET /api/agent/skills` (built-in and custom). One: `GET /api/agent/skills/{name or id}`.
- Create: `POST /api/agent/skills` `{ "name": "funded-tech-weekly", "description": "Use when … — one sentence saying when to load it", "body": "# …markdown…" }`.
- Update: `PUT /api/agent/skills/{id}` (same body). Delete: `DELETE /api/agent/skills/{id}` (approval).
- Models and whether AI is set up: `GET /api/agent/config`.

Writing a good skill:
- `name`: short kebab-case. `description`: starts with *when* to use it (that is what the agent sees in `list_skills`).
- `body`: the exact steps and API calls that worked in this chat (methods, paths, bodies with real column names),
  the user's preferences and decisions, and pitfalls you hit. No secrets, passwords or API keys.
- Prefer updating an existing custom skill over making a near-duplicate. Show the user the skill text and ask before saving.
