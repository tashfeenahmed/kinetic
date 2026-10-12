-- Knowledge Hub becomes documents only: markdown docs the user and the agent write,
-- ordered by hand (position), optionally pinned (pinned docs lead the prompt context).
-- The structured knowledge_hub row is converted into one doc per non-empty section
-- and is no longer read by the code (the table stays for now).

ALTER TABLE knowledge_docs ADD COLUMN position REAL NOT NULL DEFAULT 0;
ALTER TABLE knowledge_docs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
-- user | agent | autofill
ALTER TABLE knowledge_docs ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user';

-- Older docs keep newest-first order.
UPDATE knowledge_docs SET position = -id;
UPDATE knowledge_docs SET created_by = 'autofill' WHERE title LIKE 'Website: %';

-- Structured sections -> markdown documents (same order as the old page).
CREATE TEMP TABLE _kh_docs (workspace_id INTEGER, ord INTEGER, title TEXT, content TEXT);

INSERT INTO _kh_docs
SELECT h.workspace_id, 1, 'Company overview', trim(
  iif(trim(coalesce(json_extract(h.data, '$.company.name'), '')) != '', '**Company:** ' || trim(json_extract(h.data, '$.company.name')) || char(10), '') ||
  iif(trim(coalesce(json_extract(h.data, '$.company.website'), '')) != '', '**Website:** ' || trim(json_extract(h.data, '$.company.website')) || char(10), '') ||
  iif(trim(coalesce(json_extract(h.data, '$.company.overview'), '')) != '', char(10) || trim(json_extract(h.data, '$.company.overview')), ''))
FROM knowledge_hub h WHERE json_valid(h.data);

INSERT INTO _kh_docs
SELECT h.workspace_id, 2, 'Products & offers', (
  SELECT group_concat('## ' || trim(json_extract(o.value, '$.name')) ||
    iif(trim(coalesce(json_extract(o.value, '$.description'), '')) != '', char(10) || char(10) || trim(json_extract(o.value, '$.description')), '') ||
    iif(trim(coalesce(json_extract(o.value, '$.pricing'), '')) != '', char(10) || char(10) || '**Pricing:** ' || trim(json_extract(o.value, '$.pricing')), ''),
    char(10) || char(10))
  FROM json_each(h.data, '$.offers') o WHERE trim(coalesce(json_extract(o.value, '$.name'), '')) != '')
FROM knowledge_hub h WHERE json_valid(h.data) AND json_type(h.data, '$.offers') = 'array';

INSERT INTO _kh_docs
SELECT h.workspace_id, 3, 'Ideal customer profile', trim(
  coalesce((SELECT group_concat(line, char(10)) FROM (
    SELECT k.ord, '- **' || k.label || ':** ' || (SELECT group_concat(trim(v.value), ', ') FROM json_each(h.data, '$.icp.' || k.key) v WHERE trim(v.value) != '') AS line
    FROM (SELECT 1 ord, 'industries' key, 'Industries' label UNION ALL SELECT 2, 'sizes', 'Company sizes' UNION ALL SELECT 3, 'geos', 'Geographies'
          UNION ALL SELECT 4, 'tech', 'Tech they use' UNION ALL SELECT 5, 'triggers', 'Buying triggers') k
    WHERE json_type(h.data, '$.icp.' || k.key) = 'array' ORDER BY k.ord
  ) WHERE line IS NOT NULL), '') ||
  iif(trim(coalesce(json_extract(h.data, '$.icp.notes'), '')) != '', char(10) || char(10) || trim(json_extract(h.data, '$.icp.notes')), ''))
FROM knowledge_hub h WHERE json_valid(h.data);

INSERT INTO _kh_docs
SELECT h.workspace_id, 4, 'Buyer personas', (
  SELECT group_concat('## ' || trim(json_extract(p.value, '$.title')) ||
    iif(trim(coalesce(json_extract(p.value, '$.pains'), '')) != '', char(10) || char(10) || '**Pains:** ' || trim(json_extract(p.value, '$.pains')), '') ||
    iif(trim(coalesce(json_extract(p.value, '$.goals'), '')) != '', char(10) || char(10) || '**Goals:** ' || trim(json_extract(p.value, '$.goals')), '') ||
    iif(trim(coalesce(json_extract(p.value, '$.objections'), '')) != '', char(10) || char(10) || '**Objections:** ' || trim(json_extract(p.value, '$.objections')), ''),
    char(10) || char(10))
  FROM json_each(h.data, '$.personas') p WHERE trim(coalesce(json_extract(p.value, '$.title'), '')) != '')
FROM knowledge_hub h WHERE json_valid(h.data) AND json_type(h.data, '$.personas') = 'array';

INSERT INTO _kh_docs
SELECT h.workspace_id, 5, 'Positioning & messaging', trim(coalesce(json_extract(h.data, '$.positioning'), ''))
FROM knowledge_hub h WHERE json_valid(h.data);

INSERT INTO _kh_docs
SELECT h.workspace_id, 6, 'Competitors', (
  SELECT group_concat('- **' || trim(json_extract(c.value, '$.name')) || '**' ||
    iif(trim(coalesce(json_extract(c.value, '$.domain'), '')) != '', ' (' || trim(json_extract(c.value, '$.domain')) || ')', '') ||
    iif(trim(coalesce(json_extract(c.value, '$.notes'), '')) != '', ' — ' || trim(json_extract(c.value, '$.notes')), ''),
    char(10))
  FROM json_each(h.data, '$.competitors') c WHERE trim(coalesce(json_extract(c.value, '$.name'), '')) != '')
FROM knowledge_hub h WHERE json_valid(h.data) AND json_type(h.data, '$.competitors') = 'array';

INSERT INTO _kh_docs
SELECT h.workspace_id, 7, 'Case studies', (
  SELECT group_concat('## ' || trim(json_extract(p.value, '$.title')) ||
    iif(trim(coalesce(json_extract(p.value, '$.summary'), '')) != '', char(10) || char(10) || trim(json_extract(p.value, '$.summary')), '') ||
    iif(trim(coalesce(json_extract(p.value, '$.url'), '')) != '', char(10) || char(10) || '[Source](' || trim(json_extract(p.value, '$.url')) || ')', ''),
    char(10) || char(10))
  FROM json_each(h.data, '$.proof') p WHERE trim(coalesce(json_extract(p.value, '$.title'), '')) != '')
FROM knowledge_hub h WHERE json_valid(h.data) AND json_type(h.data, '$.proof') = 'array';

INSERT INTO _kh_docs
SELECT h.workspace_id, 8, 'Tone of voice', trim(coalesce(json_extract(h.data, '$.tone'), ''))
FROM knowledge_hub h WHERE json_valid(h.data);

INSERT INTO _kh_docs
SELECT h.workspace_id, 9, 'Do-not-target list', trim(coalesce(json_extract(h.data, '$.exclusions'), ''))
FROM knowledge_hub h WHERE json_valid(h.data);

-- Converted docs go above any existing ones, in section order.
INSERT INTO knowledge_docs (workspace_id, title, source_url, content, summary, position, pinned, created_by, created_at, updated_at)
SELECT d.workspace_id, d.title, NULL, d.content, NULL, d.ord - 1000, 0, 'user', h.updated_at, h.updated_at
FROM _kh_docs d JOIN knowledge_hub h ON h.workspace_id = d.workspace_id
WHERE d.content IS NOT NULL AND trim(d.content) != ''
ORDER BY d.workspace_id, d.ord;

DROP TABLE _kh_docs;
