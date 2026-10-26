import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { loadRagStateDatabaseConfig } from '../src/extensions/huahuo/rag/state-config.ts';

const startedAt = Date.now();

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|password|passwd|token|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(postgres(?:ql)?|https?):\/\/[^\s/:@]+:[^\s@]+@/gi, '$1://[redacted]@')
    .slice(0, 300);
}

async function main(): Promise<number> {
  if (process.env.RAG_STATE_MIGRATION_ALLOW !== 'true') {
    console.log(JSON.stringify({
      ok: false,
      status: 'BLOCKED',
      exitCode: 2,
      message: 'Set RAG_STATE_MIGRATION_ALLOW=true for the explicitly authorized test database',
    }));
    return 2;
  }
  let config: ReturnType<typeof loadRagStateDatabaseConfig>;
  try {
    config = loadRagStateDatabaseConfig(process.env, { requireTarget: true });
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      status: 'BLOCKED',
      exitCode: 2,
      message: error instanceof Error ? error.message : 'Invalid state database configuration',
    }));
    return 2;
  }
  const migrationFiles = ['0003_rag_state.sql', '0004_rag_content.sql'];
  const migrations = await Promise.all(
    migrationFiles.map(async (file) => ({ file, sql: await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8') })),
  );
  const pool = new Pool({ connectionString: config.url, max: 2 });
  try {
    await pool.query('BEGIN');
    for (const migration of migrations) await pool.query(migration.sql);
    await pool.query('COMMIT');
    console.log(JSON.stringify({
      ok: true,
      status: 'PASS',
      exitCode: 0,
      target: config.target,
      durationMs: Date.now() - startedAt,
      migrations: migrationFiles,
    }));
    return 0;
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    console.error(JSON.stringify({
      ok: false,
      status: 'FAIL',
      exitCode: 1,
      target: config.target,
      durationMs: Date.now() - startedAt,
      message: safeMessage(error),
    }));
    return 1;
  } finally {
    await pool.end();
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false,
    status: 'ERROR',
    exitCode: 3,
    message: safeMessage(error),
  }));
  process.exitCode = 3;
});

