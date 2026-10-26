function readPositiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readBoolean(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export const mastraConfig = {
  postgresPoolMax: readPositiveInteger('MASTRA_POSTGRES_POOL_MAX', 12),
  postgresIdleTimeoutMillis: readPositiveInteger('MASTRA_POSTGRES_IDLE_TIMEOUT_MS', 30_000),
  postgresSsl: readBoolean('MASTRA_POSTGRES_SSL', false),
  memoryLastMessages: readNonNegativeInteger('MASTRA_MEMORY_LAST_MESSAGES', 20),
  memoryGenerateTitle: readBoolean('MASTRA_MEMORY_GENERATE_TITLE', true),
};
