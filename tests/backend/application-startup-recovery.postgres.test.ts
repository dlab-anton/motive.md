import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus, listPostgresMigrations,
  type MigrationDescriptor } from '../../packages/accounting/src/migrations.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe=baseUrl?describe:describe.skip;

pgDescribe('application startup recovery on isolated PostgreSQL',()=>{
  const databaseName=`motive_startup_recovery_${randomUUID().replaceAll('-','')}`;
  let admin: Pool;
  let child: ChildProcess|undefined;
  let childOutput='';
  let databaseUrl: URL;

  beforeAll(async()=>{
    const source=new URL(baseUrl!);
    if (!['postgres:', 'postgresql:'].includes(source.protocol) || source.search || source.hash
      || !['127.0.0.1','localhost','::1','[::1]'].includes(source.hostname)) {
      throw new Error('Startup recovery tests require a verified loopback PostgreSQL URL.');
    }
    const adminUrl=new URL(source); adminUrl.pathname='/postgres';
    admin=new Pool({connectionString:adminUrl.toString(),max:1});
    await admin.query(`CREATE DATABASE ${databaseName}`);
    databaseUrl=new URL(source); databaseUrl.pathname=`/${databaseName}`;

    const migrations=await listPostgresMigrations();
    const baseline=migrations.slice(0,-1);
    const pendingMigration=migrations.at(-1);
    expect(baseline.length).toBeGreaterThan(0);
    expect(pendingMigration).toBeDefined();
    const setup=new Pool({connectionString:databaseUrl.toString(),max:2});
    try {
      await applyMigrations(setup,baseline);
      const status=await getPostgresSchemaStatus(setup);
      expect(status.exact).toBe(false);
      expect(status.problems).toEqual([`Missing migration ${pendingMigration!.name}.`]);
      await new LedgerKernel(setup).createProject({actorId:'operator:seed',idempotencyKey:randomUUID(),
        slug:'circle-packing',visibility:'PUBLIC',revisionContent:{title:'Startup recovery fixture'}});
    } finally { await setup.end(); }
  },30_000);

  afterAll(async()=>{
    await stopChild();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[databaseName])).rowCount).toBe(0);
      await admin.end();
    }
  });

  it('recovers the real warm Vercel handler after the missing migration is applied and then shares the ready app',async()=>{
    const taggedUrl=new URL(databaseUrl);
    taggedUrl.searchParams.set('application_name',`motive-startup-${databaseName.slice(-12)}`);
    child=fork(fileURLToPath(new URL('../fixtures/application-startup-recovery-child.mts',import.meta.url)),[],{
      cwd:fileURLToPath(new URL('../..',import.meta.url)),
      execArgv:['--import','tsx'],
      env:childEnvironment(taggedUrl.toString()),stdio:['ignore','pipe','pipe','ipc'],
    });
    child.stdout?.on('data',chunk=>{ childOutput=boundedOutput(childOutput,String(chunk)); });
    child.stderr?.on('data',chunk=>{ childOutput=boundedOutput(childOutput,String(chunk)); });
    const port=await listeningPort(child);
    const origin=`http://127.0.0.1:${port}`;

    const unavailable=await fetch(`${origin}/api/health`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({error:'The application service is unavailable.'});
    expect(await taggedConnections(taggedUrl.searchParams.get('application_name')!)).toBe(0);

    const migrations=await listPostgresMigrations();
    const pendingMigration=migrations.at(-1);
    if (!pendingMigration) throw new Error('Final migration fixture is missing.');
    const upgrade=new Pool({connectionString:databaseUrl.toString(),max:1});
    try {
      await applyMigrations(upgrade,[pendingMigration]);
      expect((await getPostgresSchemaStatus(upgrade)).exact).toBe(true);
    } finally { await upgrade.end(); }

    const recovered=await fetch(`${origin}/api/health`);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ready:true,accounts:true,projectDatabase:true});
    const connectionsAfterRecovery=await taggedConnections(taggedUrl.searchParams.get('application_name')!);
    expect(connectionsAfterRecovery).toBeGreaterThan(0);

    const shared=await fetch(`${origin}/api/health`);
    expect(shared.status).toBe(200);
    expect(await shared.json()).toEqual({ready:true,accounts:true,projectDatabase:true});
    expect(await taggedConnections(taggedUrl.searchParams.get('application_name')!)).toBe(connectionsAfterRecovery);
  },45_000);

  async function taggedConnections(applicationName: string): Promise<number> {
    const result=await admin.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname=$1 AND application_name=$2`,[databaseName,applicationName]);
    return Number(result.rows[0].count);
  }

  async function stopChild() {
    const target=child;
    child=undefined;
    if (!target || target.exitCode!==null) return;
    target.send?.({type:'shutdown'});
    const exited=await Promise.race([
      new Promise<boolean>(resolve=>target.once('exit',()=>resolve(true))),
      new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),3_000)),
    ]);
    if (!exited && target.exitCode===null) {
      target.kill();
      await Promise.race([
        new Promise<void>(resolve=>target.once('exit',()=>resolve())),
        new Promise<void>(resolve=>setTimeout(resolve,3_000)),
      ]);
    }
  }

  function childEnvironment(connectionString: string): NodeJS.ProcessEnv {
    const inherited: NodeJS.ProcessEnv={};
    for (const name of ['PATH','Path','SystemRoot','SYSTEMROOT','ComSpec','TEMP','TMP']) {
      if (process.env[name]!==undefined) inherited[name]=process.env[name];
    }
    return {...inherited,NODE_ENV:'test',VERCEL:'1',MOTIVE_APP_ORIGIN:'http://127.0.0.1:4317',
      MOTIVE_API_HOST:'127.0.0.1',MOTIVE_API_PORT:'4318',MOTIVE_DATABASE_URL:connectionString,
      MOTIVE_DATABASE_SSL:'disable',DATABASE_CONNECTION_MODE:'direct',MOTIVE_ACCOUNT_PROVIDER:'supabase',
      SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_PUBLISHABLE_KEY:`sb_publishable_${'p'.repeat(24)}`,
      SUPABASE_SECRET_KEY:`sb_secret_${'s'.repeat(24)}`,MOTIVE_AGENT_TOKEN_SECRET:'a'.repeat(48),
      MOTIVE_FUNDING_VAULT_KEY:Buffer.alloc(32,9).toString('base64url')};
  }

  function listeningPort(target: ChildProcess): Promise<number> {
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error(`Startup child did not listen. ${childOutput}`)),15_000);
      target.once('exit',code=>{ clearTimeout(timeout); reject(new Error(`Startup child exited with ${code}. ${childOutput}`)); });
      target.on('message',message=>{
        if (!message || typeof message!=='object' || !('type' in message) || message.type!=='listening'
          || !('port' in message) || !Number.isInteger(message.port)) return;
        clearTimeout(timeout); resolve(Number(message.port));
      });
    });
  }
});

async function applyMigrations(pool: Pool, migrations: readonly MigrationDescriptor[]) {
  await pool.query('CREATE SCHEMA IF NOT EXISTS motive');
  await pool.query(`CREATE TABLE IF NOT EXISTS motive.schema_migrations (
    name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
  for (const migration of migrations) {
    await pool.query('BEGIN');
    try {
      await pool.query(migration.sql);
      await pool.query('INSERT INTO motive.schema_migrations(name,checksum) VALUES($1,$2)',[migration.name,migration.checksum]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
}

function boundedOutput(previous: string, addition: string): string {
  return `${previous}${addition}`.slice(-4_000).replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi,'postgresql://[redacted]@');
}
