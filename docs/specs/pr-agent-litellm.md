# PR-Agent on the ChatGPT plan through a self-hosted LiteLLM

Status: approved by the owner on 2026-11-19 (idea-to-spec playback confirmed). Changes the PR-Agent design in [ci-foundation.md](ci-foundation.md#pr-agent-githubworkflowspr-agentyml).

Placeholders: `<server>` is the always-on self-host machine, `<tailnet>` its Tailscale network, `<owner devices>` the owner's other tailnet devices. Real names stay out of this public repo.

## 1. Starting point

**Why.** The owner turned PR-Agent off (`gh workflow list --all`: `PR-Agent disabled_manually`, checked 2026-11-19) because its only model path was pay-per-token OpenRouter, so it ran on a cheap model (`anthropic/claude-haiku-5.5`, `pr-agent.yml:51`). The owner has a ChatGPT subscription (Codex login `auth_mode: chatgpt`, `~/.codex/auth.json`, 2026-11-19) and an always-on `<server>` (sleep and suspend targets masked, systemd user lingering on, 2026-11-19). LiteLLM can serve that subscription through its `chatgpt/` provider (docs.litellm.ai/docs/providers/chatgpt).

**Current state** (all checked 2026-11-19):
- The repository is public (`gh repo view`).
- `pr-agent.yml` runs on `pull_request` and `issue_comment`, skips Bot senders and fork PRs (`pr-agent.yml:24-31`). Its model, key and reasoning are OpenRouter's (`pr-agent.yml:48-64`).
- The only imported upstream PR so far, #7, was opened by `app/learnharness-nightly-bot` from same-repo branch `upstream-pr/757`; its PR-Agent run was `skipped` (Bot sender). The Sync PR is opened by the same App from `upstream-main` (`upstream-sync.yml:118`). No stranger fork PR has ever been opened (`gh pr list --state all --limit 300`).
- A same-repo imported PR's `pull_request` runs use the PR's own workflow files and can read every repository secret; the `.github/` import guard is the mitigation (`upstream-handpicked.md:54-63`).
- `pull_request_target` always runs the default branch's workflow and can use a main-only environment (`dependabot-auto-merge.yml:9-14`). GitHub blocks `pull_request_target` on public repositories without an Actions event policy from 2026-12-02; the one existing policy covers only `dependabot-auto-merge.yml` (`gh api repos/{owner}/{repo}/actions/policies`). `pr-preview-approval.yml` also uses `pull_request_target` and is not covered, so preview approvals stop on 2026-12-02 unless added.
- PR-Agent ignores events outside `github_action_config.pr_actions` (default opened, reopened, ready_for_review, review_requested), so `labeled` must be listed; it skips pushes from bots by default (`push_trigger_ignore_bot_commits`). It supports `pull_request_target` and reads `.pr_agent.toml` from the default branch (PR-Agent v0.50.0 source).
- LiteLLM's `chatgpt/` provider: one device-code login made outside the proxy, stored in an `auth.json` the proxy rewrites on each refresh (refresh tokens are single use, so one process only). A failed refresh needs a manual re-login. It strips token-limit fields (so PR-Agent's `max_output_tokens` cap no longer applies, see `pr-agent.yml:58-60` for why the cap existed) and records spend as $0, so budgets never fire; rate limits work.
- LiteLLM virtual keys and request logs need Postgres; without it only the admin (master) key exists (docs.litellm.ai/docs/proxy/virtual_keys).
- Claude through LiteLLM is pass-through only: Claude Code sends its own login through the proxy. Anthropic forbids subscription logins in any other tool (Feb 2026).
- `<server>`: Docker running, no Postgres, about 5.8 GB memory available with swap full. Other services there already use Tailscale Serve and some local ports, so the build checks that LiteLLM's port (Defaults 7) is free and publishes LiteLLM tailnet-only.
- `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are also read by `nightly.yml:200-201` for release notes.
- LiteLLM releases: v1.108.11 (LTS line, 2026-11-17), v1.110.0 (2026-11-18). tailscale/github-action v4.4.0. PR-Agent image 0.50.0.

**I could not verify:**
- The tailnet access rules (need the admin console). If they are Tailscale's default allow-all, a CI node could reach T3 Code (which runs agents), LearnHarness and `<owner devices>`. Safe behavior: no `tag:ci` node joins until the rules below are in place.
- Whether the ChatGPT plan can call `gpt-6.2-sol`, and whether device-code login is enabled for the account.
- Whether the `chatgpt/` route works on the 1.108 LTS line, whether the bridge passes `reasoning_effort` and accepts `temperature`, and whether the PR-Agent `docker://` container can reach a tailnet address.
- Whether OpenAI's terms allow this use. The owner accepted that risk.

**First task, before any code:** re-probe the facts above (workflow state, policies, the bot's login, Sync PR branch). Then walk the owner through the setup steps below, one at a time. Then confirm the plan can call `gpt-6.2-sol`. If any fails, stop and report.

### Owner setup (before the build)

Only the owner can do these, in this order. Secrets never go in chat or git: when the builder needs one, it asks with a secret prompt.

**A. Tailscale access rules** (admin console → Access controls). Keep a copy of the current policy first, to roll back.
1. Add the tag and who may use it: `"tagOwners": { "tag:ci": ["autogroup:admin"] }`.
2. Add a name for the server: `"hosts": { "litellm-server": "<server's tailnet IP>" }` (the IP is on the Machines page).
3. Find every rule whose source is `"*"` and change the source to `"autogroup:member"`. The owner's own devices keep exactly today's access; tagged devices like `tag:ci` get none from it. In `grants` form: `{ "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] }`. In older `acls` form: `{ "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] }`.
4. Add the one CI rule. `grants`: `{ "src": ["tag:ci"], "dst": ["litellm-server"], "ip": ["tcp:4000"] }`. `acls`: `{ "action": "accept", "src": ["tag:ci"], "dst": ["litellm-server:4000"] }`.
5. Check that no other rule (including the `ssh` section) lets `"*"` or `tag:ci` reach anything else, then save. Proof check 5 confirms the result.

**B. Tailscale trusts GitHub's identity** (admin console → Trust credentials; do this after A, because the tag must exist).
1. Credential → OpenID Connect → Issuer: GitHub.
2. Subject: `repo:max-miller1204/learnharness-nightly:environment:pr-agent` (only jobs in the main-only `pr-agent` environment match).
3. Scope: Auth Keys, write. Tag: `tag:ci`.
4. Generate. Copy the Client ID and the Audience. Neither is a secret; the builder stores them in the `pr-agent` environment.

**C. ChatGPT device-code login.** On chatgpt.com: Settings → Security, turn on device-code login (for Codex). The exact label may differ. The builder later runs LiteLLM's one-time login on `<server>` and the owner approves the code at the link it prints.

**D. A new OpenRouter key.** On openrouter.ai: Settings → API Keys → Create key, named `litellm`, with a credit limit of the owner's choice. The builder asks for it with a secret prompt and stores it in `~/litellm` only.

**E. A test GitHub account.** Sign up at github.com/signup with a different email (a Gmail `+` alias works). GitHub's terms allow one free machine account per person besides their own. Don't add it as a collaborator. When the builder reaches proof check 9, it asks the owner to sign that account in to `gh` in a separate config folder, or for a token.

The builder does the rest itself: LiteLLM + Postgres on `<server>`, Tailscale Serve, the `pr-agent` environment (main-only), the Actions policy, the `ai-review` label, the workflow and docs.

## 2. Goals and non-goals

**Goals**
1. A LiteLLM proxy runs on `<server>` all the time, reachable only on `<tailnet>`. It serves the owner's OpenRouter models (a new key used only by LiteLLM), `gpt-6.2-sol` on the owner's ChatGPT login, and a Claude Code pass-through route.
2. PR-Agent reviews imported upstream PRs automatically, and any other PR only when the owner adds the `ai-review` label, once per label.
3. PR-Agent's model calls go to `gpt-6.2-sol` at medium reasoning through LiteLLM, over a temporary tailnet node that can reach nothing but LiteLLM.

**Non-goals**
- **Deferred: `task-lifecycle` on external PRs.** The owner's next spec, through `idea-to-spec`, after this one ships. Nothing here decides it; known so far:
  - Idea: the owner's label (approving one commit, like `preview`) starts the full loop (Claude + Codex review, fix, `prove-learnharness`) on an external PR, stopping before merge.
  - Open questions: where it runs (GitHub runner or a sandbox on `<server>`); where fixes go (fork PRs are review-only unless the author allows maintainer edits, and `upstream-pr/<N>` branches must keep upstream's exact commits); which secrets live where (agent logins and any push token never on the machine running PR code); a CI version of the skill (no T3 in CI, so `codex exec` for the Codex parts; web, API, agent, `lh` and Linux Electron only, no Android emulator or Mac); quota use of both subscriptions per run.
  - Already known: PR content can steer the agents, so the verdict is evidence, never permission to merge; the owner's auto-merge-on-PROVED rule must not apply to external PRs.
  - Until then: the owner runs `task-lifecycle` on the PR from T3 after reading its diff.
- No existing tool (Claude Code, Codex, T3, others) is switched to LiteLLM. The route is ready; the owner switches tools later.
- No Claude subscription for tools other than Claude Code.
- No OpenRouter fallback when the ChatGPT route fails.
- Nightly release notes keep using `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` directly.
- No public exposure of LiteLLM (no Funnel, no cloudflared, no LAN listener).
- LiteLLM's files live in `~/litellm` on `<server>`, not in this repository or the dotfiles repo.

## 3. Constraints

**Invariants**

| Invariant | Enforced or detected | Kind |
|---|---|---|
| PR-Agent's new secrets live only in a main-only `pr-agent` environment; the workflow runs on `pull_request_target` (and `issue_comment`), so only `main`'s copy ever runs with them | GitHub environment branch rule, workflow triggers | machine |
| The job never checks out or runs PR code | workflow (only the digest-pinned PR-Agent image runs) | machine (file review) |
| No stored Tailscale secret: Tailscale trusts GitHub's identity only from this repo's `pr-agent` environment | Tailscale federated identity | machine (probe) |
| `tag:ci` reaches only LiteLLM's port on `<server>`; owner devices keep today's access | Tailscale access rules | machine (probe) |
| PR-Agent's LiteLLM key can call only the ChatGPT model, rate-limited | LiteLLM virtual key (Postgres) | machine |
| A stranger's push, label or comment never starts a run; a person starts one only by the owner adding `ai-review` (exactly one run) or by a comment command from an OWNER, MEMBER or COLLABORATOR | workflow `if:`, label removal | machine |
| The Actions policy allows `pull_request_target` for `pr-agent.yml` and `pr-preview-approval.yml` | repository Actions policy | machine |
| No secret in any git repository; LiteLLM secrets stay in `~/litellm` on `<server>` | file layout | human review |
| On any failure (server off, proxy down, login expired, plan limit) the PR-Agent check goes red with a reason and posts nothing else; it never blocks a merge (not in `Check`) | workflow | machine |

**Permissions (new credentials)**

| Actor | Holds | Can | Untrusted input |
|---|---|---|---|
| PR-Agent job (GitHub) | PR-Agent's LiteLLM key, GitHub OIDC identity for Tailscale, `GITHUB_TOKEN` (PR comments, labels) | Join `<tailnet>` as `tag:ci`, call `gpt-6.2-sol`, comment, remove `ai-review` | Yes: PR diff and text (owner decision: main-only environment, label gate) |
| LiteLLM on `<server>` | ChatGPT login, new OpenRouter key, admin key, Postgres password | Call every route | Forwards prompts, never executes them |
| Owner, from tailnet devices | Admin key | Manage LiteLLM, use every route | No |
| Strangers, Dependabot, the fork bot, `tag:ci` beyond the above | Nothing new | Nothing new | |

**Entrypoints**

| Entrypoint | Runs when | Refuses |
|---|---|---|
| `pull_request_target` opened, reopened, ready_for_review | author is `learnharness-nightly-bot[bot]` **and** head branch starts with `upstream-pr/` | everything else, including the Sync PR (`upstream-main`), Dependabot, the owner's own PRs |
| `pull_request_target` labeled `ai-review` | the label was added by the repository owner, on any open PR; the workflow then removes the label | labels added by anyone else; any other label |
| `issue_comment` `/review`, `/improve`, `/describe`, `/ask` | commenter is OWNER, MEMBER or COLLABORATOR, on any PR (as today) | everyone else, plain comments, bots |
| LiteLLM HTTP API on `<tailnet>` | a valid key | no key; PR-Agent's key asking for any other model or an admin endpoint |

Worked examples: a re-import pushes as the bot, so nothing runs (owner uses the label or `/review`); the owner pushes to an imported branch, nothing runs; a stranger pushes after a labeled review, nothing runs; the owner labels their own PR, one review runs.

Irreversible effects and their single owner: public review comments (the PR-Agent job, through the triggers above); Codex allowance used (PR-Agent key's rate limits); OpenRouter spend (the cap the owner sets on the new key); tailnet reach (the owner's access rules).

LiteLLM admin UI checklist (confirmed): revocation by rotating the admin key; reachable only on `<tailnet>`, so no cross-site exposure from the internet; keys long and random; no non-prod copy.

**Stopping rules**
- Per LiteLLM request: 10-minute timeout. Per job: the existing 15-minute limit (`pr-agent.yml:39`), which is now the only output cap, since the ChatGPT backend drops `max_output_tokens`.
- PR-Agent key: 10 requests per minute, at most 2 at once.
- No retry or fallback on failure: red, with a reason.

**Ordering and rollback**
1. Owner console steps (First task). No `tag:ci` node joins before the access rules are in place.
2. LiteLLM + Postgres up on `<server>`, ChatGPT signed in, keys created, Tailscale Serve publishing LiteLLM.
3. The `pr-agent` environment and its secrets, the Actions policy, the `ai-review` label.
4. Proof checks 1 to 6, now that what they test exists.
5. The PR (workflow, docs, this spec).
6. Merge, enable the workflow, proof checks 7 to 10. Because `pull_request_target` only ever runs `main`'s copy, these can only run after merge. Rollback: `gh workflow disable PR-Agent`, fix in a follow-up PR.

**Defaults the owner accepted**
1. Imports run automatically only on opened, reopened and ready_for_review.
2. "Import" = author `learnharness-nightly-bot[bot]` and head branch `upstream-pr/*`.
3. Comment commands keep working on any PR, as today.
4. `ai-review` works on any open PR as "review this now"; only the owner adding it counts.
5. No head re-check between the label and the review (a window of seconds).
6. LiteLLM 1.108.11 (LTS line), pinned by image digest; if the `chatgpt/` route fails there, 1.110.0. Bumped by hand.
7. LiteLLM listens on `127.0.0.1:4000`; Tailscale Serve publishes it tailnet-only on port 4000.
8. PR-Agent key limits as in Stopping rules.
9. Timeouts as in Stopping rules.
10. Otherwise PR-Agent keeps today's behavior: 128k input cap, auto review and improve, no auto describe.
11. Docker Compose with `restart: unless-stopped`, one LiteLLM worker.
12. LiteLLM's ChatGPT sign-in is separate from the Codex CLI's; re-login steps live in `~/litellm/README.md`.

**Stop and ask** if: the plan can't call `gpt-6.2-sol`; the PR-Agent container can't reach the tailnet; LiteLLM + Postgres leave less than 3 GB free on `<server>`; any probe from `tag:ci` reaches anything other than LiteLLM; a probe in First task contradicts this spec.

**Left to the agent:** the layout of `~/litellm`; model alias, secret and variable names; how the workflow checks and removes the label; PR-Agent's exact config keys (reasoning, temperature, unknown-model token limit); the tailnet URL form (IP or MagicDNS); README and docs wording.

**Docs to update:** `docs/fork-workflow.md` (PR-Agent paragraph and the one-time settings list, incl. the policy), `docs/specs/ci-foundation.md` (PR-Agent section, which this spec replaces), and the header comment in `pr-agent.yml` (`OPENROUTER_MODEL` is no longer shared with PR-Agent).

## 4. Proof

**Verifies on:** `<server>`; a second owner device on `<tailnet>` (for probes from off the box); GitHub Actions on this repository; a second GitHub account for fork PRs (set up first).

| # | Proves | Surface | Check | Where | Pass |
|---|---|---|---|---|---|
| 1 | `gpt-6.2-sol` answers at medium reasoning with PR-Agent's key | LiteLLM API over `<tailnet>` | Chat request from another tailnet device, with `temperature` and `reasoning_effort` as PR-Agent sends them; read LiteLLM's log | owner device → `<server>` | Answer returned; log shows the ChatGPT route and medium effort |
| 2 | PR-Agent's key is limited | LiteLLM API | Same key asks for an OpenRouter model and an admin endpoint | owner device | Both refused |
| 3 | OpenRouter and Claude Code routes work, and nothing was switched | LiteLLM API; `claude -p` | One OpenRouter request; one `claude -p` run with temporary env pointing at LiteLLM | `<server>` | Both answer; Claude Code's settings files unchanged (diff before/after) |
| 4 | Survives a restart; memory fits | `<server>` | Restart the containers; measure memory | `<server>` | Back without manual steps; at least 3 GB available |
| 5 | `tag:ci` reaches only LiteLLM | a real `tag:ci` node from the `pr-agent` environment | Probe LiteLLM's port, T3 Code, LearnHarness, SSH, and `<owner devices>`; separately, owner devices still reach T3 Code and LearnHarness | GitHub Actions | Only LiteLLM connects; owner access unchanged |
| 6 | Policy covers both files | GitHub API | List Actions policies | GitHub | `pr-agent.yml` and `pr-preview-approval.yml` both allowed |
| 7 | Imports run automatically | a real import (upstream #757 is open) | Run Import upstream PR | GitHub | Review and suggestions posted; log shows the tailnet LiteLLM URL and `gpt-6.2-sol` |
| 8 | Owner PRs and the Sync PR skip; comments work | an owner test PR; the next Sync PR update | Open the PR, then comment `/review` | GitHub | PR open: skipped; comment: one run; Sync PR: skipped |
| 9 | The stranger path | a fork PR from the test account | Open it; owner adds `ai-review`; test account pushes; test account comments `/review` | GitHub | Skipped; one run and the label removed; skipped; skipped |
| 10 | Fails red | `/review` with LiteLLM stopped | Stop LiteLLM, comment, restart | GitHub + `<server>` | Red with a reason naming the proxy; nothing else posted |

Checks 1 to 6 pass before merge, after the environment and the Actions policy exist (Ordering step 3); 7 to 10 pass right after merge, or the workflow is disabled again (rollback).

Not applicable: data migration, app code, project invariants list or ADRs (the repository has none; decisions live here and in `docs/fork-workflow.md`).
