import { randomUUID } from 'node:crypto';
import packageMetadata from '../../package.json';

export interface TelemetryConfig {
  env: string;
  service: 'huahuo-agent';
  role: 'agent';
  version: string;
  service_instance_id: string;
  metricsEnabled: boolean;
  metricsHost: string;
  metricsPort: number;
  tracesEndpoint?: string;
}

function identifier(value: string | undefined, fallback: string, name: string): string {
  const trimmed=value?.trim();
  if (!trimmed) return fallback;
  if (!/^[A-Za-z0-9._:@+-]{1,128}$/u.test(trimmed)) throw new Error(`${name}_INVALID`);
  return trimmed;
}

export function telemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const enabled = env.METRICS_ENABLED ?? 'true';
  if (!['true', 'false'].includes(enabled)) throw new Error('METRICS_ENABLED_INVALID');
  const port = Number(env.METRICS_PORT ?? 9464);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('METRICS_PORT_INVALID');
  const host = env.METRICS_HOST?.trim() || '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new Error('METRICS_HOST_INVALID');
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (endpoint) {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error('OTEL_TRACES_ENDPOINT_INVALID'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('OTEL_TRACES_ENDPOINT_INVALID');
    }
  }
  const appEnv=env.APP_ENV?.trim()||'development';
  if(!['development','test','production','prod'].includes(appEnv))throw new Error('APP_ENV_INVALID');
  if(env.LOG_LEVEL&&!['debug','info','warn','error'].includes(env.LOG_LEVEL))throw new Error('LOG_LEVEL_INVALID');
  return {
    env: appEnv==='production'?'prod':appEnv, service: 'huahuo-agent', role: 'agent',
    version: identifier(env.OTEL_SERVICE_VERSION, packageMetadata.version, 'OTEL_SERVICE_VERSION'),
    service_instance_id: identifier(env.OTEL_SERVICE_INSTANCE_ID, randomUUID(), 'OTEL_SERVICE_INSTANCE_ID'),
    metricsEnabled: enabled === 'true', metricsHost: host, metricsPort: port,
    ...(endpoint ? { tracesEndpoint: endpoint } : {}),
  };
}

export const telemetryIdentity = telemetryConfig();
export function resourceFields(config = telemetryIdentity) {
  return { env: config.env, service: config.service, role: config.role, version: config.version, service_instance_id: config.service_instance_id };
}
