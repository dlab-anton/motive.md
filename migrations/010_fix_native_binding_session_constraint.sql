-- PostgreSQL bounds regex repetition counts at 255. Keep the applied migration
-- immutable and enforce the 512-character session cap separately.
ALTER TABLE motive.native_workspace_bindings
  DROP CONSTRAINT native_workspace_bindings_session_id_check,
  ADD CONSTRAINT native_workspace_bindings_session_id_check
    CHECK (char_length(session_id) BETWEEN 1 AND 512 AND session_id ~ '^[A-Za-z0-9_-]+$');
