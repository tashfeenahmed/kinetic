-- Knowledge Hub folders (nested, Notion-like). Folders and docs share one ordering
-- (position) among the children of the same parent; folder_id NULL = top level.
-- Deleting folders is handled in code (move the contents up, or delete them).

CREATE TABLE knowledge_folders (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES knowledge_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX knowledge_folders_ws ON knowledge_folders (workspace_id, parent_id);

ALTER TABLE knowledge_docs ADD COLUMN folder_id INTEGER REFERENCES knowledge_folders(id) ON DELETE SET NULL;
CREATE INDEX knowledge_docs_folder ON knowledge_docs (workspace_id, folder_id);
