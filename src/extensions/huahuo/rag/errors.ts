export class UnsupportedSearchModeError extends Error {
  public readonly mode: string;

  constructor(mode: string) {
    super(`Search mode "${mode}" is not available in the configured provider`);
    this.mode = mode;
    this.name = 'UnsupportedSearchModeError';
  }
}

export type RagErrorCode =
  | 'RAG_CONFIG_INVALID'
  | 'EMBEDDING_CONFIGURATION_MISSING'
  | 'EMBEDDING_PROVIDER_UNAVAILABLE'
  | 'EMBEDDING_PROVIDER_TIMEOUT'
  | 'EMBEDDING_RESPONSE_INVALID'
  | 'DOCUMENT_INPUT_INVALID'
  | 'DOCUMENT_EMPTY'
  | 'DOCUMENT_VERSION_CONFLICT'
  | 'INDEX_VERSION_NOT_READY'
  | 'MILVUS_UNAVAILABLE'
  | 'MILVUS_SCHEMA_INCOMPATIBLE'
  | 'INGEST_FAILED';

export class RagError extends Error {
  public readonly code: RagErrorCode;
  public readonly retryable: boolean;

  constructor(
    code: RagErrorCode,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RagError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export class RagConfigurationError extends RagError {
  constructor(message: string) {
    super('RAG_CONFIG_INVALID', message);
    this.name = 'RagConfigurationError';
  }
}

export class EmbeddingConfigurationError extends RagError {
  constructor(message: string) {
    super('EMBEDDING_CONFIGURATION_MISSING', message);
    this.name = 'EmbeddingConfigurationError';
  }
}

export class EmbeddingProviderError extends RagError {
  kind: 'authentication' | 'rate_limit' | 'server' | 'invalid_request' | 'network' | 'timeout' | 'response' = 'response';
  httpStatus?: number;

  constructor(
    code: 'EMBEDDING_PROVIDER_UNAVAILABLE' | 'EMBEDDING_PROVIDER_TIMEOUT' | 'EMBEDDING_RESPONSE_INVALID',
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(code, message, options);
    this.name = 'EmbeddingProviderError';
  }
}

export class DocumentInputError extends RagError {
  constructor(message: string) {
    super('DOCUMENT_INPUT_INVALID', message);
    this.name = 'DocumentInputError';
  }
}

export class EmptyDocumentError extends RagError {
  constructor(message = 'Document content is empty after normalization') {
    super('DOCUMENT_EMPTY', message);
    this.name = 'EmptyDocumentError';
  }
}

export class DocumentVersionConflictError extends RagError {
  constructor(message: string) {
    super('DOCUMENT_VERSION_CONFLICT', message);
    this.name = 'DocumentVersionConflictError';
  }
}

export class IngestError extends RagError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('INGEST_FAILED', message, { retryable: true, ...options });
    this.name = 'IngestError';
  }
}
