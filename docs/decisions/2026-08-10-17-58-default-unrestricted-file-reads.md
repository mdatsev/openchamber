# 2026-08-10-17-58: default unrestricted file reads

- **Type:** decision
- **Decided by:** user
- **Status:** current
- **What:** Permit authenticated clients to read files outside the active workspace by default.
- **Context:** Workspace-bound stat and read routes prevent the web UI from rendering agent-produced temporary files, even though the authenticated user can run arbitrary commands and move those files into the workspace.
- **Reason (user):** "I don't think it is a security concern since the user can run arbitrary commands to move any file to the workspace and view it anyway."
- **Reason (agent):** Limit unrestricted access to stat, text-read, and raw-read operations. Keep writes and static serving workspace-bound as defense in depth against unintended mutation and active-content exposure.
