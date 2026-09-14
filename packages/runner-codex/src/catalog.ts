/**
 * Minimal ModelInfo catalogue accepted by @openai/codex 0.153.4.
 *
 * In this Codex version, `supports_parallel_tool_calls` is not a runtime
 * ModelInfo field. The only catalogue field that forces the request flag false
 * is `use_responses_lite`, which also changes the Responses wire format. This
 * fixture intentionally preserves the regular Responses transport.
 */
export const CODEX_CATALOG_VERSION = "0.153.4";
export const LOCAL_MOCK_MODEL = "motive-local-mock-v1";

export const LOCAL_MOCK_MODEL_CATALOG = {
  models: [{
    slug: LOCAL_MOCK_MODEL,
    display_name: "Motive deterministic local mock",
    description: "Trusted offline compatibility fixture for Codex 0.153.4.",
    default_reasoning_level: "low",
    supported_reasoning_levels: [{
      effort: "low",
      description: "Deterministic fixture reasoning level",
    }],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    availability_nux: null,
    upgrade: null,
    model_messages: {
      instructions_template: "You are running a bounded local compatibility fixture. Follow the user request and use only the tools supplied in the request.",
      instructions_variables: null,
      approvals: null,
      collaboration_modes: null,
      auto_review: null,
      permissions: null,
      multi_agent: null,
    },
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_image_detail_original: false,
    context_window: 272_000,
    max_context_window: 272_000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: true,
  }],
} as const;

export function serializeLocalMockModelCatalog(): string {
  return `${JSON.stringify(LOCAL_MOCK_MODEL_CATALOG, null, 2)}\n`;
}
