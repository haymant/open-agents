import { Octokit } from "@octokit/rest";
import { updateSession } from "@/lib/db/sessions";
import { getServerSession } from "@/lib/session/get-server-session";
import { getUserGitHubToken } from "@/lib/github/token";

// Allow up to 2 minutes for git operations
export const maxDuration = 120;

export async function POST(req: Request) {
  // 1. Validate session
  const serverSession = await getServerSession();
  if (!serverSession?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  // 2. Parse request body
  let body: {
    sessionId: string;
    repoName: string;
    description?: string;
    isPrivate?: boolean;
    sessionTitle?: string;
    owner: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId, repoName, description, isPrivate, owner } = body;
  if (!sessionId || !repoName || !owner) {
    return Response.json(
      { error: "Missing required fields: sessionId, repoName, owner" },
      { status: 400 },
    );
  }

  // 3. Get user's GitHub OAuth token
  const token = await getUserGitHubToken(serverSession.user.id);
  if (!token) {
    return Response.json(
      {
        error:
          "GitHub account not connected. Please connect GitHub in settings.",
      },
      { status: 400 },
    );
  }

  // 4. Create Octokit and determine if repo should be created under user or org
  const octokit = new Octokit({ auth: token });

  try {
    // Fetch the authenticated user to compare against the requested owner
    const { data: authenticatedUser } =
      await octokit.rest.users.getAuthenticated();
    const isUserOwner =
      authenticatedUser.login.toLowerCase() === owner.toLowerCase();

    let repo;
    if (isUserOwner) {
      // Create repo under the authenticated user
      repo = await octokit.rest.repos.createForAuthenticatedUser({
        name: repoName,
        description: description ?? "",
        private: isPrivate ?? true,
        auto_init: true,
      });
    } else {
      // Create repo under an organization
      repo = await octokit.rest.repos.createInOrg({
        org: owner,
        name: repoName,
        description: description ?? "",
        private: isPrivate ?? true,
        auto_init: true,
      });
    }

    const cloneUrl = repo.data.clone_url;
    const defaultBranch = repo.data.default_branch;

    // 5. Update the session with the new repo info
    await updateSession(sessionId, {
      repoOwner: owner,
      repoName,
      cloneUrl,
      branch: defaultBranch,
    });

    // 6. Return success
    return Response.json({
      repoUrl: repo.data.html_url,
      owner,
      repoName,
      cloneUrl,
      branch: defaultBranch,
    });
  } catch (error) {
    // Map common GitHub API errors to user-friendly messages
    const message =
      error instanceof Error ? error.message : "Failed to create repository";

    if (
      message.includes("name already exists") ||
      message.includes("already exists")
    ) {
      return Response.json(
        {
          error: `Repository "${owner}/${repoName}" already exists on GitHub.`,
        },
        { status: 409 },
      );
    }

    if (message.includes("Not Found")) {
      return Response.json(
        {
          error: `Organization "${owner}" not found or you don't have access to create repositories there.`,
        },
        { status: 404 },
      );
    }

    if (message.includes("Forbidden") || message.includes("403")) {
      return Response.json(
        {
          error: `You don't have permission to create repositories under "${owner}".`,
        },
        { status: 403 },
      );
    }

    console.error("[create-repo] GitHub API error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
