import type { Session } from "@/lib/session/types";

export const MANAGED_TEMPLATE_TRIAL_MESSAGE_LIMIT = 5;
export const MANAGED_TEMPLATE_TRIAL_SESSION_LIMIT = 1;
export const MANAGED_TEMPLATE_TRIAL_MESSAGE_LIMIT_ERROR =
  "This hosted demo has a 5 message limit. Deploy your own copy to unlock the full Open Agents template.";
export const MANAGED_TEMPLATE_TRIAL_SESSION_LIMIT_ERROR =
  "This hosted demo includes 1 trial session. Deploy your own copy to unlock the full Open Agents template.";
export const MANAGED_TEMPLATE_TRIAL_DELETE_MESSAGE_ERROR =
  "Message deletion is disabled in the hosted demo. Deploy your own copy to unlock full controls.";
export const MANAGED_TEMPLATE_TRIAL_CODE_EDITOR_ERROR =
  "The code editor is disabled in the hosted demo. Deploy your own copy to unlock the full Open Agents template.";
export const MANAGED_TEMPLATE_TRIAL_GITHUB_SESSION_ERROR =
  "GitHub-backed sessions are disabled in the hosted demo. Deploy your own copy to unlock repository support, or start a new chat without a repository.";

export function isManagedTemplateDeployment(_url: string | URL) {
  return false;
}

export function hasAllowedManagedTemplateEmail(_email?: string) {
  return false;
}

export function isManagedTemplateTrialUser(
  _session: Pick<Session, "authProvider" | "user"> | null | undefined,
  _url: string | URL,
) {
  return false;
}
