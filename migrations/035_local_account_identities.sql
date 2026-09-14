-- Better Auth owns local credentials in SQLite. PostgreSQL retains only the
-- durable identity boundary needed by project authority and review services.

ALTER TABLE motive.account_identities
  ALTER COLUMN subject_id TYPE TEXT USING subject_id::text;

ALTER TABLE motive.account_identities
  DROP CONSTRAINT account_identities_provider_check;

ALTER TABLE motive.account_identities
  ADD CONSTRAINT account_identities_provider_check
    CHECK (provider IN ('supabase','local-better-auth')),
  ADD CONSTRAINT account_identities_subject_provider_check
    CHECK ((provider='supabase'
      AND subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR (provider='local-better-auth'
        AND subject_id ~ '^[A-Za-z0-9._~-]+$'
        AND char_length(subject_id) BETWEEN 1 AND 480)),
  ADD CONSTRAINT account_identities_local_actor_binding_check
    CHECK (provider<>'local-better-auth' OR actor_id='account:' || subject_id);

COMMENT ON COLUMN motive.account_identities.subject_id IS
  'Provider-native immutable subject. Supabase subjects remain canonical UUID text; local Better Auth subjects retain their exact native string.';
