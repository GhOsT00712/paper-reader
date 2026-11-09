CREATE TABLE pdf_positions (
  paper_id INTEGER NOT NULL,
  version TEXT NOT NULL,
  page INTEGER NOT NULL,
  offset REAL NOT NULL,
  PRIMARY KEY (paper_id, version)
);

CREATE TABLE pdf_highlights (
  paper_id INTEGER NOT NULL,
  version TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT,
  PRIMARY KEY (paper_id, version, id)
);

CREATE TABLE pdf_sync_batches (
  paper_id INTEGER NOT NULL,
  version TEXT NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY (paper_id, version, id)
);
