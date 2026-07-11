/**
 * Coolify sandbox connector configuration.
 *
 * Connectors are loaded from environment variables for the headless MCP bridge.
 * In the future, the Settings UI at /settings/sandbox-connectors can manage
 * these via database storage.
 */

export interface CoolifyConnectorConfig {
  /** Unique connector ID (e.g., "default", "staging") */
  id: string;
  /** Display name */
  name: string;
  /** Coolify API base URL */
  baseUrl: string;
  /** Coolify API token */
  apiToken: string;
  /** Coolify project UUID */
  projectUuid: string;
  /** Coolify destination (Docker engine) UUID */
  destinationUuid: string;
  /** Coolify server UUID (optional — auto-discovered if not set) */
  serverUuid?: string;
  /** Docker image to deploy (e.g., "haymant/oai") */
  dockerImage: string;
}

/**
 * Load Coolify connector configs from environment variables.
 *
 * Uses TEST_COOLIFY_* vars for testing, or COOLIFY_* vars for production.
 * Multiple connectors can be configured via COOLIFY_CONNECTOR_IDS.
 */
export function loadCoolifyConnectorConfigs(): CoolifyConnectorConfig[] {
  const ids = (process.env.COOLIFY_CONNECTOR_IDS ?? "default")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Detect test vs production prefix
  const envBaseUrl = process.env.TEST_COOLIFY_BASE_URL;
  const isTest = !!envBaseUrl;

  const prefix = isTest ? "TEST_COOLIFY_" : "COOLIFY_";

  return ids.map((id) => {
    const suffix =
      id === "default" ? "" : `_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    return {
      id,
      name: id === "default" ? "Default Coolify" : `Coolify ${id}`,
      baseUrl: process.env[`${prefix}BASE_URL${suffix}`] ?? "",
      apiToken: process.env[`${prefix}API_KEY${suffix}`] ?? "",
      projectUuid: process.env[`${prefix}PROJECT_UUID${suffix}`] ?? "",
      destinationUuid: process.env[`${prefix}DESTINATION_UUID${suffix}`] ?? "",
      serverUuid: process.env[`${prefix}SERVER_UUID${suffix}`] || undefined,
      dockerImage:
        process.env[`${prefix}DOCKER_IMAGE${suffix}`] ?? "haymant/oai",
    };
  });
}

/**
 * Resolve a connector config by ID.
 */
export function getCoolifyConnectorConfig(
  id: string,
): CoolifyConnectorConfig | undefined {
  const configs = loadCoolifyConnectorConfigs();
  return configs.find((c) => c.id === id);
}

/**
 * Validate that a connector config has all required fields.
 */
export function validateCoolifyConnectorConfig(
  config: CoolifyConnectorConfig,
): string | null {
  const missing: string[] = [];
  if (!config.baseUrl) missing.push("baseUrl");
  if (!config.apiToken) missing.push("apiToken");
  if (!config.projectUuid) missing.push("projectUuid");
  if (!config.destinationUuid) missing.push("destinationUuid");
  if (missing.length > 0) {
    return `Coolify connector "${config.id}" is missing: ${missing.join(", ")}`;
  }
  return null;
}
