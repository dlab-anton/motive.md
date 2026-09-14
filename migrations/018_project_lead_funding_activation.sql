-- A donor may authorize a project-owned hosted attempt without receiving its
-- run bearer. Existing donor-agent activations remain fully represented.

ALTER TABLE motive.provider_project_budgets
  ADD COLUMN beneficiary_actor_id TEXT CHECK (beneficiary_actor_id IS NULL OR char_length(beneficiary_actor_id) BETWEEN 1 AND 512);
UPDATE motive.provider_project_budgets
  SET beneficiary_actor_id = 'agent:' || assigned_agent_id::text
  WHERE assigned_agent_id IS NOT NULL;
ALTER TABLE motive.provider_project_budgets
  ADD CONSTRAINT provider_project_budgets_beneficiary_check CHECK (
    status <> 'ACTIVE' OR (
      beneficiary_actor_id IS NOT NULL
      AND (assigned_agent_id IS NULL OR beneficiary_actor_id = 'agent:' || assigned_agent_id::text)
    )
  );

ALTER TABLE motive.provider_budget_activations
  ADD COLUMN beneficiary_actor_id TEXT CHECK (beneficiary_actor_id IS NULL OR char_length(beneficiary_actor_id) BETWEEN 1 AND 512);
UPDATE motive.provider_budget_activations
  SET beneficiary_actor_id = 'agent:' || assigned_agent_id::text
  WHERE assigned_agent_id IS NOT NULL;
ALTER TABLE motive.provider_budget_activations ALTER COLUMN assigned_agent_id DROP NOT NULL;
ALTER TABLE motive.provider_budget_activations DROP CONSTRAINT provider_budget_activations_check;
ALTER TABLE motive.provider_budget_activations DROP CONSTRAINT provider_budget_activations_status_check;
ALTER TABLE motive.provider_budget_activations
  ADD CONSTRAINT provider_budget_activations_status_check CHECK (status IN ('PENDING', 'ACTIVE', 'AWAITING_DISPATCH', 'REVOKED')),
  ADD CONSTRAINT provider_budget_activations_shape_check CHECK (
    (status = 'ACTIVE' AND grant_id IS NOT NULL AND attempt_id IS NOT NULL
      AND capability_id IS NOT NULL AND capability_expires_at IS NOT NULL
      AND assigned_agent_id IS NOT NULL AND beneficiary_actor_id = 'agent:' || assigned_agent_id::text)
    OR (status = 'AWAITING_DISPATCH' AND grant_id IS NOT NULL AND attempt_id IS NOT NULL
      AND capability_id IS NULL AND capability_expires_at IS NULL
      AND assigned_agent_id IS NULL AND beneficiary_actor_id IS NOT NULL)
    OR status IN ('PENDING', 'REVOKED')
  );

REVOKE ALL ON motive.provider_project_budgets FROM PUBLIC;
REVOKE ALL ON motive.provider_budget_activations FROM PUBLIC;
