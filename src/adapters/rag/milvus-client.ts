import {
  MilvusClient,
  type ClientConfig,
} from '@zilliz/milvus2-sdk-node';
import type { MilvusConnectionConfig } from '../../extensions/huahuo/rag/milvus-poc-config.ts';

export type MilvusErrorKind =
  | 'authentication'
  | 'network'
  | 'timeout'
  | 'tls'
  | 'api'
  | 'unknown';

export class MilvusClientError extends Error {
  public readonly kind: MilvusErrorKind;

  constructor(
    kind: MilvusErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.kind = kind;
    this.name = 'MilvusClientError';
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const value = error as Record<string, unknown>;
    return [
      value.message,
      value.reason,
      value.detail,
      value.error_code,
      value.code,
    ]
      .filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
      .join(' ');
  }
  return 'Milvus request failed';
}

function classifyError(error: unknown): MilvusErrorKind {
  const value = errorText(error).toLowerCase();
  if (
    value.includes('authentication') ||
    value.includes('unauthenticated') ||
    value.includes('permission denied') ||
    value.includes('invalid username') ||
    value.includes('invalid password') ||
    value.includes('user hasn')
  ) {
    return 'authentication';
  }
  if (
    value.includes('deadline exceeded') ||
    value.includes('timed out') ||
    value.includes('timeout') ||
    value.includes('etimedout')
  ) {
    return 'timeout';
  }
  if (
    value.includes('ssl') ||
    value.includes('tls') ||
    value.includes('certificate') ||
    value.includes('handshake')
  ) {
    return 'tls';
  }
  if (
    value.includes('unavailable') ||
    value.includes('connection') ||
    value.includes('econn') ||
    value.includes('enotfound') ||
    value.includes('network')
  ) {
    return 'network';
  }
  if (
    value.includes('method not found') ||
    value.includes('unimplemented') ||
    value.includes('unknown service') ||
    value.includes('invalid argument') ||
    value.includes('not support')
  ) {
    return 'api';
  }
  return 'unknown';
}

/** Keep diagnostic output useful without echoing SDK internals or credentials. */
export function safeMilvusMessage(error: unknown): string {
  const message = errorText(error)
    .replace(/(password|passwd|token|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(root|admin|user):[^\s]+@/gi, '$1:[redacted]@')
    .replace(/\b(postgres(?:ql)?|https?):\/\/[^\s/:@]+:[^\s@]+@/gi, '$1://[redacted]@');
  return message.slice(0, 300);
}

export async function createMilvusClient(
  config: MilvusConnectionConfig,
): Promise<MilvusClient> {
  const clientConfig: ClientConfig = {
    address: config.address,
    username: config.username,
    password: config.password,
    database: config.database,
    timeout: config.connectTimeoutMs,
    maxRetries: 0,
    ssl: config.tls,
    logLevel: 'error',
  };

  const client = new MilvusClient(clientConfig);
  try {
    await client.connectPromise;
    return client;
  } catch (error) {
    try {
      await client.closeConnection();
    } catch {
      // Preserve the original classified connection error.
    }
    const kind = classifyError(error);
    throw new MilvusClientError(
      kind,
      `Milvus ${kind} error: ${safeMilvusMessage(error)}`,
      { cause: error },
    );
  }
}

export function classifyMilvusError(error: unknown): MilvusErrorKind {
  return classifyError(error);
}
