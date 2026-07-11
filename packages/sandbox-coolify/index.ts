import type { Sandbox, ConnectOptions } from "@open-agents/sandbox";
import {
  CoolifySandbox,
  CoolifyFileSystem,
  type CoolifyState,
} from "./sandbox";

export { CoolifySandbox, CoolifyFileSystem, type CoolifyState };
export type { CoolifyPreviewUrls } from "./sandbox";

/**
 * Configuration for connecting to a Coolify sandbox.
 * Mirrors SandboxConnectConfig from @open-agents/sandbox/factory.
 */
export type CoolifyConnectConfig = {
  state: CoolifyState;
  options?: ConnectOptions;
};

function buildPersistedCoolifyState(
  state: CoolifyState,
  runtimeState: unknown,
): CoolifyState {
  const nextState: CoolifyState = {
    type: "coolify",
    ...(state.connectorConfigId
      ? { connectorConfigId: state.connectorConfigId }
      : {}),
    ...(state.connectorName ? { connectorName: state.connectorName } : {}),
    ...(state.coolifyApplicationId
      ? { coolifyApplicationId: state.coolifyApplicationId }
      : {}),
    ...(state.coolifyApplicationUrl
      ? { coolifyApplicationUrl: state.coolifyApplicationUrl }
      : {}),
    ...(state.coolifyPreviewUrls
      ? { coolifyPreviewUrls: state.coolifyPreviewUrls }
      : {}),
  };

  if (runtimeState && typeof runtimeState === "object") {
    const rt = runtimeState as Record<string, unknown>;
    if (typeof rt.sandboxName === "string")
      nextState.sandboxName = rt.sandboxName;
    if (typeof rt.sandboxId === "string") nextState.sandboxId = rt.sandboxId;
    if (typeof rt.snapshotId === "string") nextState.snapshotId = rt.snapshotId;
    if (typeof rt.expiresAt === "number") nextState.expiresAt = rt.expiresAt;
    if (rt.source && typeof rt.source === "object") {
      nextState.source = rt.source as CoolifyState["source"];
    }
  }

  if (!nextState.sandboxName && state.sandboxName)
    nextState.sandboxName = state.sandboxName;
  if (!nextState.sandboxId && state.sandboxId)
    nextState.sandboxId = state.sandboxId;
  if (!nextState.snapshotId && state.snapshotId)
    nextState.snapshotId = state.snapshotId;
  if (nextState.expiresAt === undefined && state.expiresAt !== undefined)
    nextState.expiresAt = state.expiresAt;
  if (!nextState.source && state.source) nextState.source = state.source;

  return nextState;
}

/**
 * Connect to a Coolify sandbox.
 * Mirrors connectSandbox() API: accepts (state, options?) or ({ state, options }).
 */
export async function connectCoolify(
  configOrState: CoolifyConnectConfig | CoolifyState,
  legacyOptions?: ConnectOptions,
): Promise<Sandbox> {
  const isNewApi =
    typeof configOrState === "object" &&
    configOrState !== null &&
    "state" in configOrState &&
    typeof (configOrState as CoolifyConnectConfig).state === "object" &&
    (configOrState as CoolifyConnectConfig).state !== null &&
    "type" in (configOrState as CoolifyConnectConfig).state;

  let state: CoolifyState;
  let options: ConnectOptions | undefined;

  if (isNewApi) {
    const config = configOrState as CoolifyConnectConfig;
    state = config.state;
    options = config.options;
  } else {
    state = configOrState as CoolifyState;
    options = legacyOptions;
  }

  const sandbox = await CoolifySandbox.connect(state, options);
  const originalGetState = sandbox.getState.bind(sandbox);

  Object.defineProperty(sandbox, "getState", {
    configurable: true,
    value: () => buildPersistedCoolifyState(state, originalGetState()),
    writable: true,
  });

  return sandbox;
}
