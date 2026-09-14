-- Run after ledger migrations as a privileged operator. This group role has no
-- login credential; create a fresh application login separately and grant it
-- only motive_control_reader membership.
DO $provision$
DECLARE
  target_role pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO target_role FROM pg_roles WHERE rolname = 'motive_control_reader';
  IF NOT FOUND THEN
    EXECUTE 'CREATE ROLE motive_control_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  ELSE
    IF target_role.rolcanlogin
      OR target_role.rolsuper
      OR target_role.rolcreatedb
      OR target_role.rolcreaterole
      OR target_role.rolinherit
      OR target_role.rolreplication
      OR target_role.rolbypassrls THEN
      RAISE EXCEPTION 'existing motive_control_reader has unsafe role attributes';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member = target_role.oid) THEN
      RAISE EXCEPTION 'existing motive_control_reader is a member of another role';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_database database_record WHERE database_record.datdba = target_role.oid) THEN
      RAISE EXCEPTION 'existing motive_control_reader owns a database';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace namespace_record WHERE namespace_record.nspowner = target_role.oid) THEN
      RAISE EXCEPTION 'existing motive_control_reader owns a schema';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class relation_record WHERE relation_record.relowner = target_role.oid) THEN
      RAISE EXCEPTION 'existing motive_control_reader owns a relation';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc routine_record WHERE routine_record.proowner = target_role.oid) THEN
      RAISE EXCEPTION 'existing motive_control_reader owns a routine';
    END IF;
  END IF;
END
$provision$;

DO $verify_no_write$
DECLARE
  relation_record RECORD;
BEGIN
  IF has_database_privilege('motive_control_reader', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'motive_control_reader has database CREATE privilege';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_namespace namespace_record
    WHERE namespace_record.nspname !~ '^pg_(temp|toast_temp)_'
      AND has_schema_privilege('motive_control_reader', namespace_record.oid, 'CREATE')
  ) THEN
    RAISE EXCEPTION 'motive_control_reader has schema CREATE privilege';
  END IF;

  FOR relation_record IN
    SELECT relation.oid, namespace_record.nspname, relation.relname
    FROM pg_class relation
    JOIN pg_namespace namespace_record ON namespace_record.oid = relation.relnamespace
    WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND namespace_record.nspname !~ '^pg_(catalog|toast|temp|toast_temp)'
      AND namespace_record.nspname <> 'information_schema'
  LOOP
    IF has_table_privilege('motive_control_reader', relation_record.oid, 'INSERT')
      OR has_table_privilege('motive_control_reader', relation_record.oid, 'UPDATE')
      OR has_table_privilege('motive_control_reader', relation_record.oid, 'DELETE')
      OR has_table_privilege('motive_control_reader', relation_record.oid, 'TRUNCATE')
      OR has_table_privilege('motive_control_reader', relation_record.oid, 'REFERENCES')
      OR has_table_privilege('motive_control_reader', relation_record.oid, 'TRIGGER') THEN
      RAISE EXCEPTION 'motive_control_reader already has write privilege on %.%', relation_record.nspname, relation_record.relname;
    END IF;
  END LOOP;
END
$verify_no_write$;

REVOKE ALL PRIVILEGES ON SCHEMA motive FROM motive_control_reader;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA motive FROM motive_control_reader;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA motive FROM motive_control_reader;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA motive FROM motive_control_reader;
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. This private
-- schema exposes no routine to the read service, including through PUBLIC.
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA motive FROM PUBLIC;

GRANT USAGE ON SCHEMA motive TO motive_control_reader;
GRANT SELECT (name, checksum)
  ON TABLE motive.schema_migrations TO motive_control_reader;
GRANT SELECT (id, slug, visibility, current_revision)
  ON TABLE motive.projects TO motive_control_reader;
GRANT SELECT (project_id, revision, content)
  ON TABLE motive.project_revisions TO motive_control_reader;
GRANT SELECT (project_id, actor_id, revoked_at)
  ON TABLE motive.memberships TO motive_control_reader;
GRANT SELECT (
  id, project_id, issuer_actor_id, limit_amount, consumed_amount,
  attempt_held_amount, status, expires_at, created_at
)
  ON TABLE motive.grants TO motive_control_reader;
GRANT SELECT (id, work_order_id, project_id, terms_digest)
  ON TABLE motive.attempts TO motive_control_reader;
GRANT SELECT (environment_id, attempt_id, status, manifest_digest, created_at)
  ON TABLE motive.orchestration_artifact_seals TO motive_control_reader;
GRANT SELECT (
  id, project_id, work_order_id, attempt_id, artifact_environment_id,
  evaluator_environment_id, artifact_manifest_digest, terms_digest,
  evaluator_profile_digest, challenge_digest, dependency_lock_digest,
  trusted_build_config_digest, raw_report_digest, assessment_digest, outcome, created_at
)
  ON TABLE motive.evaluations TO motive_control_reader;
GRANT SELECT (id, evaluation_id, decision, created_at)
  ON TABLE motive.acceptance_decisions TO motive_control_reader;
