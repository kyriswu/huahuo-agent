-- RAG state migration. Apply only to an explicitly authorized test database.
-- This file is intentionally not executed by application startup.

CREATE TABLE IF NOT EXISTS rag_document_heads (
  document_id TEXT PRIMARY KEY,
  active_document_version TEXT,
  active_pipeline_version TEXT,
  generation BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rag_document_versions (
  idempotency_key TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  pipeline_version TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions > 0),
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  run_id TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'visible', 'superseded')),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, document_version, pipeline_version)
);

CREATE INDEX IF NOT EXISTS rag_document_versions_document_idx
  ON rag_document_versions (document_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS rag_document_versions_status_idx
  ON rag_document_versions (status);

CREATE TABLE IF NOT EXISTS rag_ingestion_jobs (
  job_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'retry_wait', 'completed', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  fencing_token BIGINT NOT NULL DEFAULT 0,
  last_completed_batch INTEGER NOT NULL DEFAULT -1,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- These tables intentionally use logical references rather than foreign keys.
-- Job creation is coordinated with version creation by the application, while
-- retries may discover a persisted job before a version row has been repaired.
-- A database unique idempotency key still prevents duplicate logical jobs;
-- recovery must verify both records before claiming work.

CREATE INDEX IF NOT EXISTS rag_ingestion_jobs_recovery_idx
  ON rag_ingestion_jobs (status, lease_until, next_attempt_at);

CREATE TABLE IF NOT EXISTS rag_index_chunks (
  idempotency_key TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content_hash CHAR(64) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'written', 'verified', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (idempotency_key, chunk_id)
);

