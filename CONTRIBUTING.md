# Contributing to Kinetic

Thanks for helping! Kinetic is open to contributions of every size: bug reports, docs, new data sources, enrichment providers, signals, agent skills and UI polish.

## Ways to help

- **Report a bug.** Open an issue with what you did, what you expected and what happened. Include the page or API route, logs (with keys removed) and your Node.js version.
- **Suggest a feature.** Open an issue describing the problem first; it's easier to agree on an approach before code is written.
- **Pick up an issue.** Comment on it so nobody duplicates the work.
- **Improve the docs.** README, `docs/` and the agent skills in `server/src/agent/skills/` are all Markdown.

## Getting set up

You need **Node.js 24+**. Docker is only needed for the real-mail tests.

```bash
git clone https://github.com/tashfeenahmed/kinetic.git
cd kinetic
npm install
npm run dev          # API with reload + Vite on http://localhost:5273
```

Want realistic data to click around in? See *Try it with demo data* in the [README](README.md#-quick-start).

## Before you open a pull request

```bash
npm test             # unit + API tests (vitest)
npm run typecheck    # server, web and extension
```

For changes to sending, inbox sync, warmup or placement, also run the real SMTP/IMAP tests:

```bash
npm run mail:up && npm run test:mail
```

Then:

1. Branch from `main` and keep the pull request focused on one change.
2. Add or update tests for what you changed. API behaviour is tested through the HTTP routes (see `server/test/helpers.ts`).
3. Write a clear description: what changed, why, and how you tested it. Screenshots help for UI changes.

## How the code is organised

| Path | What lives there |
|---|---|
| `server/src/routes/`, `engine/`, `mail/` | Outreach: API routes, sequencer, inbox sync, warmup, placement, webhooks |
| `server/src/gtm/` | Tables: engine, enrichment providers and waterfalls, AI research, signals, outreach bridge |
| `server/src/agent/` | The chat agent: tools, approval policy, and skills (Markdown playbooks) |
| `server/src/sourcing/` | Lead sources (maps, registers, funding rounds, job boards…) |
| `web/src/` | React + Vite + Tailwind UI; `web/src/gtm/` is the tables UI |
| `extension/` | Kinetic Companion browser extension |

## Conventions

- **TypeScript, run natively.** The server runs `.ts` files directly on Node 24; there is no build step for it. Import with the `.ts` extension.
- **Match the surrounding code**: naming, comment density and style.
- **Free first.** New enrichment steps should prefer free sources and only fall back to paid vendors; paid calls must be metered through the credits helpers so budgets apply.
- **Every API route the agent can call must be covered by a skill.** `server/test/agent-coverage.test.ts` enforces this. When you add a route, mention it in the relevant file in `server/src/agent/skills/`.
- **Risky actions need approval.** Routes that send email, delete data, launch campaigns or spend credits belong in the agent approval policy (`server/src/agent/policy.ts`).
- **Database changes** go in a new numbered file in `server/src/db/migrations/`. Never edit a migration that has shipped.

## Keep secrets and real people out

- Never commit API keys, tokens, passwords, `.env` files or anything from `data/`.
- Use fictional people, companies and domains in tests, fixtures, docs and screenshots (`*.example`, `*.test`, `acme.test`…), never real ones.

## Security issues

Please don't open a public issue for a vulnerability. Report it privately through GitHub's **Security → Report a vulnerability** on this repository.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
