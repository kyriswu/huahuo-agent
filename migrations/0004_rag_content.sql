-- Canonical RAG chunk content.  Milvus stores the derived vector and small
-- retrieval fields; this table is the source of truth for text and citations.
-- Apply only to the explicitly authorized RAG state database.

CREATE TABLE IF NOT EXISTS rag_chunk_contents (
  idempotency_key TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  chunk_hash CHAR(64) NOT NULL,
  document_content_hash CHAR(64) NOT NULL,
  chunker_version TEXT NOT NULL,
  text TEXT NOT NULL,
  heading_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  knowledge_base_id TEXT NOT NULL,
  run_id TEXT,
  document_version_state TEXT NOT NULL CHECK (document_version_state IN ('building', 'ready', 'retired', 'deleted')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (idempotency_key, chunk_id)
);

CREATE INDEX IF NOT EXISTS rag_chunk_contents_version_idx
  ON rag_chunk_contents (document_id, document_version, pipeline_version, chunk_index);
CREATE INDEX IF NOT EXISTS rag_chunk_contents_visible_idx
  ON rag_chunk_contents (tenant_id, knowledge_base_id, document_version_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS rag_chunk_contents_chunk_idx
  ON rag_chunk_contents (chunk_id);
