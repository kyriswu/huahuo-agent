// Local ENV assertions only. No network, database, credentials or value output.
const env = process.env;
const validPort = value => /^\d{1,5}$/u.test(value) && Number(value) >= 1 && Number(value) <= 65535;
const validId = value => !value?.trim() || /^[A-Za-z0-9._:@+-]{1,128}$/u.test(value.trim());
const valid = env.APP_ENV === 'test'
  && ['true', 'false'].includes(env.METRICS_ENABLED ?? 'true')
  && ['127.0.0.1', '::1', '0.0.0.0'].includes(env.METRICS_HOST?.trim() || '127.0.0.1')
  && validPort(env.METRICS_PORT ?? '9464')
  && ['127.0.0.1', '::1'].includes(env.METRICS_BIND_HOST || '127.0.0.1')
  && validPort(env.METRICS_HOST_PORT || '9469')
  && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  && validId(env.OTEL_SERVICE_VERSION)
  && validId(env.OTEL_SERVICE_INSTANCE_ID)
  && ['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL || 'info');
if (!valid) { console.error('AGENT_OBSERVABILITY_CONFIG_INVALID'); process.exitCode = 1; }
else console.log('AGENT_OBSERVABILITY_CONFIG_VALID');
