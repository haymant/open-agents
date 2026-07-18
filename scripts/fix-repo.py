#!/usr/bin/env python3
with open('apps/web/app/api/acpmcp/route.ts', 'r') as f:
    content = f.read()

old = (
    '    const installation = installations.find((i) =>\n'
    '      org ? i.account?.login === org : true,\n'
    '    );\n'
    '    if (!installation?.id)\n'
    '      throw new Error("No suitable GitHub App installation found");\n'
    '\n'
    '    const installationOctokit = new Octokit({\n'
    '      authStrategy: createAppAuth,\n'
    '      auth: {\n'
    '        appId: process.env.GITHUB_APP_ID ?? "",\n'
    '        privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? "",\n'
    '        installationId: installation.id,\n'
    '      },\n'
    '    });\n'
    '\n'
    '    const result = org\n'
    '      ? await installationOctokit.rest.repos.createInOrg({\n'
    '          org,\n'
    '          name: repoName,\n'
    '          private: isPrivate ?? true,\n'
    '          auto_init: true,\n'
    '        })\n'
    '      : await installationOctokit.rest.repos.createForAuthenticatedUser({\n'
    '          name: repoName,\n'
    '          private: isPrivate ?? true,\n'
    '          auto_init: true,\n'
    '        });\n'
    '\n'
    '    return { repoUrl: result.data.html_url, cloneUrl: `${result.data.html_url}.git` };'
)

new = (
    '    const installation = installations.find((i) =>\n'
    '      org ? i.account?.login === org : true,\n'
    '    );\n'
    '    if (!installation?.id)\n'
    '      throw new Error("No suitable GitHub App installation found");\n'
    '    if (!installation.account?.login)\n'
    '      throw new Error("Installation has no account login");\n'
    '\n'
    '    const targetOrg = org ?? installation.account.login;\n'
    '\n'
    '    const installationOctokit = new Octokit({\n'
    '      authStrategy: createAppAuth,\n'
    '      auth: {\n'
    '        appId: process.env.GITHUB_APP_ID ?? "",\n'
    '        privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? "",\n'
    '        installationId: installation.id,\n'
    '      },\n'
    '    });\n'
    '\n'
    '    const result = await installationOctokit.rest.repos.createInOrg({\n'
    '      org: targetOrg,\n'
    '      name: repoName,\n'
    '      private: isPrivate ?? true,\n'
    '      auto_init: true,\n'
    '    });\n'
    '\n'
    '    return { repoUrl: result.data.html_url, cloneUrl: `${result.data.html_url}.git` };'
)

assert old in content, "Old text not found"
content = content.replace(old, new)

with open('apps/web/app/api/acpmcp/route.ts', 'w') as f:
    f.write(content)
print("OK")
