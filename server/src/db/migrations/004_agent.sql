-- Kinetic Agent: chat sessions that build tables, enrich and set up outreach by calling
-- the API in-process; user-written skills; and the Knowledge Hub (what we sell, to whom).

CREATE TABLE agent_sessions (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT,                              -- NULL = AGENT_MODEL / AI_MODEL default
  -- idle | running | waiting (ask_user / approval) | error
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agent_sessions_ws ON agent_sessions (workspace_id, updated_at);

CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                      -- user | assistant | tool
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,                         -- assistant: JSON array (OpenAI format)
  tool_call_id TEXT,                       -- tool: the call it answers
  tool_name TEXT,
  tool_args TEXT,                          -- tool: JSON arguments
  -- tool: running | done | failed | waiting | skipped
  status TEXT NOT NULL DEFAULT 'done',
  meta TEXT NOT NULL DEFAULT '{}',         -- UI: label, links, pending question/approval
  created_at TEXT NOT NULL
);
CREATE INDEX agent_messages_session ON agent_messages (session_id, id);

CREATE TABLE agent_skills (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

-- One structured hub per workspace (JSON sections) plus free-form source documents.
CREATE TABLE knowledge_hub (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE knowledge_docs (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_url TEXT,
  content TEXT NOT NULL DEFAULT '',
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX knowledge_docs_ws ON knowledge_docs (workspace_id, id);
