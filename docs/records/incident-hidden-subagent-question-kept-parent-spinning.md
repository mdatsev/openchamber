# Incident: hidden subagent question kept parent spinning

- **Type:** record
- **Purpose:** Record why an apparently stalled parent session remained busy and showed a spinner after its child subagent needed user input.
- **When to read:** When a visible parent session remains busy without output, especially while a Task subagent is running or after a provider stream error.

## Resolution (TL;DR)

The reported parent was not interrupted: one explore subagent continued running, recovered from a transient OpenAI API error, and then opened a question in its child session. Parent-facing activity, sidebar, and switcher status now scope authoritative pending questions to the full session subtree, so a hidden child question presents as input needed instead of a parent spinner.

## Status

fixed

## Timeline + investigation

- Session `ses_013b99681ffeT83U6ZVKe9hrtI` launched two explore subagents at 2026-08-10 18:25:34 EEST.
- The diff-architecture child (`ses_013b886eeffe6T3f9NNSPWxvD1`) received an OpenAI API stream error at 18:32:22. OpenCode retried two seconds later; the child continued through step 61, including compaction, so that error did not interrupt the turn.
- The sibling worktree-indicator child completed at 18:38:34 after about 13 minutes.
- At 18:40:39 the remaining child opened a `question` tool request. Its parent Task tool and the visible root session correctly remained authoritatively `busy` while waiting for that child.
- Chat question rendering already used `useScopedBlockingQuestions`, which includes descendant sessions, but `useSessionActivity`, sidebar rows, and the session switcher read only requests keyed directly to the visible parent session. Those surfaces therefore continued showing live activity even though the actionable state existed in a hidden child.
- The same day's OpenCode log contained 19 provider stream errors, including multiple five-minute response-header timeouts. These explain long periods without output but are not evidence that a turn has terminated; overriding authoritative `busy` from elapsed time would misclassify legitimate model, tool, retry, and compaction work.
- The fix reuses subtree-scoped authoritative request collection for parent-facing activity and indicators. Unexpected interruption remains reserved for the existing stronger signal: an unfinished assistant turn predating a successful authoritative status snapshot that omits the session from the active set.
