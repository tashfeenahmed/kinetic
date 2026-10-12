/**
 * Agent skills: markdown playbooks the agent loads on demand. Built-ins are every
 * `skills/*.md` file next to this module (read fresh each time, so files other
 * features drop in are picked up); custom skills live in `agent_skills` per workspace.
 * Only names and descriptions go into the system prompt.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/db.ts';

export const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'skills');

export interface Skill {
  name: string;
  description: string;
  body: string;
  builtin: boolean;
  id?: number;
  updated_at?: string;
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Splits `---\nkey: value\n---\nbody`. Values may be quoted or continue on indented lines. */
export function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const text = src.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  let last: string | null = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      last = kv[1];
      meta[last] = unquote(kv[2].trim().replace(/^[>|]-?$/, ''));
    } else if (last && /^\s+\S/.test(line)) {
      meta[last] = `${meta[last]} ${unquote(line.trim())}`.trim();
    }
  }
  return { meta, body: m[2].trim() };
}

function unquote(v: string) {
  return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
}

export function builtinSkills(dir = SKILLS_DIR): Skill[] {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  const out: Skill[] = [];
  for (const f of files) {
    try {
      const { meta, body } = parseFrontmatter(readFileSync(join(dir, f), 'utf8'));
      const name = meta.name || f.replace(/\.md$/, '');
      if (out.some((s) => s.name === name)) continue;
      out.push({ name, description: meta.description || body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 200) || name, body, builtin: true });
    } catch { /* unreadable file: skip */ }
  }
  return out;
}

export function customSkills(db: Db, workspaceId: number): Skill[] {
  return db.all('SELECT id, name, description, body, updated_at FROM agent_skills WHERE workspace_id = ? ORDER BY name', [workspaceId])
    .map((r) => ({ id: r.id, name: r.name, description: r.description, body: r.body, updated_at: r.updated_at, builtin: false }));
}

/** Built-ins first; a custom skill can't shadow a built-in name. */
export function allSkills(db: Db, workspaceId: number): Skill[] {
  const builtin = builtinSkills();
  const names = new Set(builtin.map((s) => s.name));
  return [...builtin, ...customSkills(db, workspaceId).filter((s) => !names.has(s.name))];
}

export function findSkill(db: Db, workspaceId: number, name: string): Skill | undefined {
  const key = name.trim().toLowerCase().replace(/\.md$/, '');
  return allSkills(db, workspaceId).find((s) => s.name.toLowerCase() === key);
}

export function skillsIndex(skills: Skill[]): string {
  return skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
}
