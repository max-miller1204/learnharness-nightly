# Remote-safe attachments

The owner approved roadmap item 24 as two PRs on 2026-11-18. PR 1 delivers individual files and uses LearnHarness main at `03c91c5` as its base. PR 2 starts from merged PR 1.

## PR 1 · Individual files

- Paired browsers can attach individual files in the opening composer and when sending a later message in an idle chat. Archives count as individual files. Sends require message text. Folder uploads, downloads, previews, attachment-only sends, and mid-turn attachment sends are outside this release.
- Selection starts uploading and displays progress. Send can be pressed during upload and waits for all files before dispatch. Failed uploads offer Retry and Remove and preserve the draft. Reloading during an interrupted upload requires reselecting the file.
- Each message can carry up to 100 files. Each image can be at most 10 MiB and images together at most 80 MiB per message. Each other file can be at most 50 MiB. Claimed uploads are limited to 1 GiB per chat. Pending bytes and upload reservations share a 512 MiB server limit. Reserve capacity before accepting bytes and identify the limit when it is reached.
- Protocol 1 adds the optional `attachment-uploads-v1` capability. The browser uses its paired cookie. Native clients can use the same contract with an existing paired bearer credential. Staged IDs are scoped to the pairing and to the opening draft or existing target chat. Check current pairing on each operation. The signed byte route skips Next.js Proxy body buffering and applies the same pairing, origin, and protocol checks.
- Upload grants last 10 minutes. Stream the bytes to a temporary file and require the exact declared size. Hash bytes only to compare duplicate upload retries. Copy on claim so a failed send can retry against the pending source.
- The opening send preserves model selection and graph context. It saves the chat, opening message, and attachment references as one recoverable operation before making the chat visible or starting the turn. A refusal leaves the draft intact without creating an empty chat. Retrying the same send does not duplicate the chat, message, or claim.
- A saved attachment has a display filename and an opaque server ID. Restricted File access permits the agent to read claimed copies referenced by its current chat, subject to the existing protected-path checks. Local desktop files and folders and existing server paths remain live references. Existing path chips, image snapshots, and graph imports continue to work.
- Sweep at startup and every 15 minutes. Pending files expire after 24 hours and partial files after one hour. Skip active uploads and claims. Chat deletion schedules retryable removal of unreferenced claimed bytes. Live references protect their files. Launcher snapshots do not retain bytes.
- Store self-hosted attachment bytes beside `userdata`. Automatic rollback and `lh restore` leave those bytes in place. A restored message referencing missing bytes shows the file's original name and **“File unavailable. Attach it again to use it.”** The agent's read reports the file as unavailable. A manual full recovery copy includes both roots with the server stopped. This release adds no backup or export command.

## Pinned T3 parity

The approved source audit used T3 stable v0.1.10 at `7d32075e3757ded707914e2450c3e392a9665765` and main at `d0a754d`. The individual-file composer, archive treatment, message and per-file size limits, and waiting for uploads on ordinary Send follow T3. [Stable composer guide](https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/docs/user/composer.md#attach-files) · [Stable send behavior](https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/apps/web/src/components/chat/useComposerSend.ts#L908-L925)

The signed grant duration, exact byte counting, duplicate retry comparison, copy-on-claim, and pending and partial cleanup thresholds follow T3's stable implementation. Deferred collection ignores snapshots. Automatic rollback leaves the attachment files in place. [Upload implementation](https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/apps/server/src/assets/AttachmentUpload.ts#L150-L266) · [Claim implementation](https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/apps/server/src/orchestration-v2/AttachmentClaims.ts#L66-L149) · [Retention thresholds](https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/apps/server/src/attachmentStore.ts#L29-L31) · [Rollback boundary](https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/docs/internals/server-updates.md#database-rollback)

LearnHarness supplies the aggregate quotas, capability and pairing contract, draft and chat ownership checks, recoverable opening send, restricted reader integration, sweep schedule, and unavailable-file message. The audit found no ordinary per-thread quota in T3. The sibling directory applies the approved rollback boundary to LearnHarness's broader `userdata` snapshots. [T3 manual recovery guidance](https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/docs/user/thread-migration.md#keeping-a-recovery-copy)

## PR 2 · Remote folders

- Add a folder picker on clients that support it. Phones remain files-only. Preserve each file's relative layout under the chat's attachments so existing read-only `ls`, `find`, and `grep` can browse it.
- Each folder can contain up to 100 files and 256 MiB total. PR 1's per-file, per-message, staging, and per-chat limits also apply. Each contained file counts toward the message limit. Identify any exceeded limit before send.
- Show one chip with the folder name and file count in drafts and saved messages. Show overall progress with Retry or Remove on failure in the draft. Give the agent a reference to the stored folder root.
- Validate the full manifest before accepting bytes. Reject the whole folder for absolute paths, traversal, malformed separators, duplicate destinations, or file/directory collisions. Create only regular files and directories within its assigned root. Show the offending entry where possible and preserve the rest of the draft.
- Remote folders extend T3. LearnHarness has no shell and its reader identifies a ZIP as an archive. Existing server file and folder paths still refer to their original location without uploading, copying, or comparing bytes.

## Acceptance

Prove PR 1 on the exact PR head with `prove-learnharness`, synthetic fixtures, a deterministic model, the production proxy and isolated state. Drive opening and later sends, reload and agent read, failure and retry without duplicate records, and legacy path, image snapshot, graph import and capability-off compatibility. Exercise interrupted upload, concurrent quota reservations, expired grants, revoked pairings, wrong device/chat/draft, and protected-path refusal. Prove that rollback preserves claimed, pending and partial bytes and that deletion protects live references. Restore a message whose file was collected and verify the unavailable state.

PR 2 separately proves a nested opening folder, browsable layout after reload, and whole-folder failure for unsafe paths and exceeded limits.
