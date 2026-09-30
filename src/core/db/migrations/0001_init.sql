-- Pyxis workspace schema. user_version is set by the migration runner, not here.
-- IDs are UUIDv7 text. Timestamps are unix milliseconds.

CREATE TABLE profile (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  education_level TEXT,
  school TEXT,
  course TEXT,
  wording_level TEXT,
  tutor_mode TEXT,
  content_language TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE engines (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE feature_engines (
  feature TEXT PRIMARY KEY,
  selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  blob_sha TEXT,
  mime TEXT,
  status TEXT NOT NULL DEFAULT 'added',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE source_documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  tree_json TEXT NOT NULL CHECK (json_valid(tree_json)),
  created_at INTEGER NOT NULL,
  UNIQUE (source_id, version)
);

-- rowid is the integer key sqlite-vec can store. id is the UUIDv7 everything else cites.
CREATE TABLE passages (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  source_id TEXT REFERENCES sources(id) ON DELETE RESTRICT,
  document_id TEXT REFERENCES source_documents(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1,
  text TEXT NOT NULL,
  locator_json TEXT CHECK (locator_json IS NULL OR json_valid(locator_json)),
  section_path TEXT,
  char_start INTEGER,
  char_end INTEGER,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE passages_fts USING fts5(
  text,
  content='passages',
  content_rowid='rowid'
);

CREATE TRIGGER passages_ai AFTER INSERT ON passages BEGIN
  INSERT INTO passages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER passages_ad AFTER DELETE ON passages BEGIN
  INSERT INTO passages_fts(passages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE VIRTUAL TABLE passages_vec USING vec0(
  passage_rowid INTEGER PRIMARY KEY,
  embedding float[384]
);

CREATE TABLE smartbooks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE REFERENCES sources(id) ON DELETE CASCADE,
  meta_json TEXT NOT NULL CHECK (json_valid(meta_json)),
  created_at INTEGER NOT NULL
);

CREATE TABLE exercises (
  id TEXT PRIMARY KEY,
  smartbook_id TEXT REFERENCES smartbooks(id) ON DELETE CASCADE,
  passage_id TEXT REFERENCES passages(id) ON DELETE RESTRICT,
  prompt TEXT NOT NULL,
  answer TEXT,
  locator_json TEXT CHECK (locator_json IS NULL OR json_valid(locator_json)),
  engine_provider TEXT,
  model_id TEXT,
  model_source TEXT CHECK (model_source IS NULL OR model_source IN ('reported', 'selected')),
  prompt_template TEXT,
  prompt_version TEXT,
  grounding TEXT CHECK (grounding IS NULL OR grounding IN ('sources', 'mixed', 'general')),
  created_at INTEGER NOT NULL
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  content_language TEXT,
  engine_provider TEXT,
  model_id TEXT,
  model_source TEXT CHECK (model_source IS NULL OR model_source IN ('reported', 'selected')),
  prompt_template TEXT,
  prompt_version TEXT,
  grounding TEXT CHECK (grounding IS NULL OR grounding IN ('sources', 'mixed', 'general')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE plan_sources (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  PRIMARY KEY (plan_id, source_id)
);

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES topics(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  engine_provider TEXT,
  model_id TEXT,
  model_source TEXT CHECK (model_source IS NULL OR model_source IN ('reported', 'selected')),
  prompt_template TEXT,
  prompt_version TEXT,
  grounding TEXT CHECK (grounding IS NULL OR grounding IN ('sources', 'mixed', 'general')),
  created_at INTEGER NOT NULL
);

CREATE TABLE topic_passages (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  passage_id TEXT NOT NULL REFERENCES passages(id) ON DELETE RESTRICT,
  PRIMARY KEY (topic_id, passage_id)
);

CREATE TABLE path_nodes (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  engine_provider TEXT,
  model_id TEXT,
  model_source TEXT CHECK (model_source IS NULL OR model_source IN ('reported', 'selected')),
  prompt_template TEXT,
  prompt_version TEXT,
  grounding TEXT CHECK (grounding IS NULL OR grounding IN ('sources', 'mixed', 'general')),
  created_at INTEGER NOT NULL
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  engine_provider TEXT,
  model_id TEXT,
  model_source TEXT CHECK (model_source IS NULL OR model_source IN ('reported', 'selected')),
  prompt_template TEXT,
  prompt_version TEXT,
  grounding TEXT CHECK (grounding IS NULL OR grounding IN ('sources', 'mixed', 'general')),
  created_at INTEGER NOT NULL
);

CREATE TABLE item_passages (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  passage_id TEXT NOT NULL REFERENCES passages(id) ON DELETE RESTRICT,
  PRIMARY KEY (item_id, passage_id)
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  engine_provider TEXT,
  model_id TEXT,
  model_source TEXT CHECK (model_source IS NULL OR model_source IN ('reported', 'selected')),
  prompt_template TEXT,
  prompt_version TEXT,
  grounding TEXT CHECK (grounding IS NULL OR grounding IN ('sources', 'mixed', 'general')),
  created_at INTEGER NOT NULL
);

CREATE TABLE card_reviews (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  reviewed_at INTEGER NOT NULL
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  started_at INTEGER NOT NULL,
  submitted_at INTEGER
);

CREATE TABLE attempt_answers (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL
);

CREATE TABLE gaps (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE gap_items (
  gap_id TEXT NOT NULL REFERENCES gaps(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (gap_id, item_id)
);

CREATE TABLE maps (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
  engine_provider TEXT,
  model_id TEXT,
  model_source TEXT CHECK (model_source IS NULL OR model_source IN ('reported', 'selected')),
  prompt_template TEXT,
  prompt_version TEXT,
  grounding TEXT CHECK (grounding IS NULL OR grounding IN ('sources', 'mixed', 'general')),
  created_at INTEGER NOT NULL
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  body TEXT NOT NULL,
  engine_provider TEXT,
  model_id TEXT,
  model_source TEXT CHECK (model_source IS NULL OR model_source IN ('reported', 'selected')),
  prompt_template TEXT,
  prompt_version TEXT,
  grounding TEXT CHECK (grounding IS NULL OR grounding IN ('sources', 'mixed', 'general')),
  created_at INTEGER NOT NULL
);

CREATE TABLE message_passages (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  passage_id TEXT NOT NULL REFERENCES passages(id) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  PRIMARY KEY (message_id, passage_id)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  blob_sha TEXT NOT NULL,
  mime TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE whiteboards (
  id TEXT PRIMARY KEY,
  title TEXT,
  blob_sha TEXT,
  scene_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scene_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE flags (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE learning_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'answer_given',
    'card_rated',
    'lesson_opened',
    'lesson_completed',
    'simulation_submitted',
    'active_time',
    'gap_opened',
    'gap_closed'
  )),
  plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  session_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'
  )),
  progress REAL NOT NULL DEFAULT 0,
  step_label TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE job_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  error TEXT,
  UNIQUE (job_id, name)
);

CREATE INDEX jobs_state ON jobs(state, created_at);
CREATE INDEX messages_chat ON messages(chat_id, created_at);
CREATE INDEX passages_source ON passages(source_id);
CREATE INDEX learning_events_plan ON learning_events(plan_id, created_at);
CREATE INDEX job_steps_job ON job_steps(job_id, position);
