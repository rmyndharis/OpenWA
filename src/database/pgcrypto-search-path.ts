import { QueryRunner } from 'typeorm';

/**
 * On PostgreSQL 12 and older gen_random_uuid() comes from pgcrypto, and the migrations call it unqualified, so it
 * has to resolve through the connection's search_path. pg_extension is database-wide: a pgcrypto installed in a
 * schema off that path passes the presence check, and the first DEFAULT then fails with "function
 * gen_random_uuid() does not exist", which reads as if pgcrypto were missing. Refuse first, naming the schema.
 * Both reads are catalog queries that cannot fail, as a caught SQL error would abort the migration transaction.
 */
export async function assertPgcryptoOnSearchPath(queryRunner: QueryRunner, versionNum: number): Promise<void> {
  const probe = (await queryRunner.query(`SELECT to_regprocedure('gen_random_uuid()') IS NULL AS missing`)) as
    { missing?: boolean }[] | undefined;
  if (!probe?.[0]?.missing) return;
  const rows = (await queryRunner.query(
    `SELECT n.nspname AS schema, current_setting('search_path') AS path ` +
      `FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto'`,
  )) as { schema?: string; path?: string }[] | undefined;
  const schema = rows?.[0]?.schema;
  throw new Error(
    `PostgreSQL ${versionNum} (< 13) takes gen_random_uuid() from the pgcrypto extension, which is installed in ` +
      `schema "${schema}", outside this connection's search_path (${rows?.[0]?.path}). It must live in ` +
      `POSTGRES_SCHEMA or public: have a superuser run "ALTER EXTENSION pgcrypto SET SCHEMA public;" once, then ` +
      `restart. Anything else that calls pgcrypto as "${schema}".<function> then has to use public.`,
  );
}
