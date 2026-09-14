-- Durable OAuth 2.1 authorization for the hosted MCP resource. OAuth bearer
-- material is retained only as SHA-256 digests; project credentials remain in
-- the participation credential domain.

CREATE TABLE motive.mcp_oauth_clients (
  client_id TEXT PRIMARY KEY CHECK (client_id ~ '^[0-9a-f-]{36}$'),
  metadata JSONB NOT NULL CHECK (jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=8192),
  redirect_uris TEXT[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 20),
  client_name TEXT NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 120),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '31 days')
);

CREATE TABLE motive.mcp_oauth_authorization_requests (
  id UUID PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES motive.mcp_oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
  resource TEXT NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 2048),
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes)=1),
  state TEXT CHECK (state IS NULL OR char_length(state) BETWEEN 1 AND 1024),
  code_challenge TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decision TEXT CHECK (decision IS NULL OR decision IN ('APPROVED','DENIED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
  CHECK ((decision IS NULL AND decided_at IS NULL) OR (decision IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX mcp_oauth_requests_expiry_idx ON motive.mcp_oauth_authorization_requests(expires_at);

CREATE TABLE motive.mcp_oauth_grants (
  id UUID PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES motive.mcp_oauth_clients(client_id) ON DELETE CASCADE,
  owner_actor_id TEXT NOT NULL REFERENCES motive.account_identities(actor_id) ON DELETE RESTRICT,
  credential_id UUID NOT NULL REFERENCES motive.participation_agent_tokens(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  resource TEXT NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 2048),
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes)=1),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '30 days'),
  CHECK (revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX mcp_oauth_grants_owner_idx ON motive.mcp_oauth_grants(owner_actor_id,created_at DESC);
CREATE INDEX mcp_oauth_grants_credential_idx ON motive.mcp_oauth_grants(credential_id) WHERE revoked_at IS NULL;

CREATE TABLE motive.mcp_oauth_authorization_codes (
  id UUID PRIMARY KEY,
  code_digest TEXT NOT NULL UNIQUE CHECK (code_digest ~ '^sha256:[a-f0-9]{64}$'),
  request_id UUID NOT NULL UNIQUE REFERENCES motive.mcp_oauth_authorization_requests(id) ON DELETE CASCADE,
  grant_id UUID NOT NULL REFERENCES motive.mcp_oauth_grants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES motive.mcp_oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
  resource TEXT NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 2048),
  code_challenge TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at>=created_at)
);
CREATE INDEX mcp_oauth_codes_expiry_idx ON motive.mcp_oauth_authorization_codes(expires_at);

CREATE TABLE motive.mcp_oauth_access_tokens (
  id UUID PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  grant_id UUID NOT NULL REFERENCES motive.mcp_oauth_grants(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '1 hour'),
  CHECK (revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX mcp_oauth_access_expiry_idx ON motive.mcp_oauth_access_tokens(expires_at);

CREATE TABLE motive.mcp_oauth_refresh_tokens (
  id UUID PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  grant_id UUID NOT NULL REFERENCES motive.mcp_oauth_grants(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  replacement_id UUID UNIQUE REFERENCES motive.mcp_oauth_refresh_tokens(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '30 days'),
  CHECK (consumed_at IS NULL OR consumed_at>=created_at),
  CHECK (revoked_at IS NULL OR revoked_at>=created_at),
  CHECK (replacement_id IS NULL OR consumed_at IS NOT NULL)
);
CREATE INDEX mcp_oauth_refresh_expiry_idx ON motive.mcp_oauth_refresh_tokens(expires_at);
CREATE INDEX mcp_oauth_refresh_grant_idx ON motive.mcp_oauth_refresh_tokens(grant_id);

ALTER TABLE motive.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.mcp_oauth_authorization_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.mcp_oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.mcp_oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.mcp_oauth_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.mcp_oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON motive.mcp_oauth_clients,motive.mcp_oauth_authorization_requests,motive.mcp_oauth_grants,
  motive.mcp_oauth_authorization_codes,motive.mcp_oauth_access_tokens,motive.mcp_oauth_refresh_tokens FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','motive_control_reader'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON motive.mcp_oauth_clients,motive.mcp_oauth_authorization_requests,motive.mcp_oauth_grants,motive.mcp_oauth_authorization_codes,motive.mcp_oauth_access_tokens,motive.mcp_oauth_refresh_tokens FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
