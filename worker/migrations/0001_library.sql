CREATE TABLE IF NOT EXISTS summaries (
  video_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  video_url TEXT NOT NULL,
  summarized_at TEXT NOT NULL,
  output_language TEXT NOT NULL,
  summaries_json TEXT NOT NULL,
  keywords_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS summaries_by_date ON summaries(summarized_at DESC);

CREATE TABLE IF NOT EXISTS library_keywords (
  normalized TEXT PRIMARY KEY,
  keyword TEXT NOT NULL
) WITHOUT ROWID;
