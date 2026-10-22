# CLI reference

[English](cli.md) · [简体中文](cli.zh-CN.md) · [Back to README](../README.md)

Always select the intended project with `--project /absolute/path/to/project`. Use the connection belonging to the original conversation. Run `session-bridge --help` for the command list.

## Command map

| Command | Purpose |
| --- | --- |
| `init --project PATH` | Initialize a selected project. |
| `connect --harness codex --alias NAME --project PATH` | Enroll from an original Codex chat. Other apps use their native integration entry points. |
| `context --json` | Read authenticated source context and a request ID. |
| `sessions --query NAME --json` | Find connected sessions by alias. |
| `wizard` | Select main/supervisor roles in an interactive terminal; no task is dispatched. |
| `request --stdin --json` | Submit a structured operation. |
| `status --task TASK_ID` | Read a task; omit `--task` to list the current session's visible tasks and roles. |
| `report --stdin` | Submit an actual summary and artifact paths. |
| `return --stdin` | Prepare/reconcile handback to the original main conversation. |
| `supervise --stdin` | Register checks for a specific actual run. |
| `recover --stdin` | Reconcile the original message. |
| `cancel --stdin` | Cancel future actions or supervision. |
| `daemon start --project PATH` | Start the local project service; Ctrl-C closes it. |
| `doctor --project PATH` | Diagnose setup without restarting apps. |

All examples below assume the selected project; add `--project PATH` to each command when needed. `PATH`, `NAME`, and `TASK_ID` denote values to replace.

## Structured requests

Write operations accept a JSON object via standard input, up to 64 KiB. Treat user text as data; never interpolate it into a shell command.

1. Run `session-bridge context --json` from the original connected session.
2. Obtain the target alias using `sessions`.
3. Write a private request file using the actual `request_id` returned by context.
4. Submit that file with fixed input redirection:

```bash
session-bridge request --project /absolute/path/to/project --stdin --json < roles.json
```

The shape of `roles.json` is:

```json
{
  "operation": "assign_roles",
  "request_id": "replace-with-the-id-from-context",
  "main": "current",
  "supervisor": { "query": "supervisor" }
}
```

This records roles only. It does not create a task or monitoring schedule. Preserve the actual request ID and original payload for reconciliation after timeouts.

| Operation | Required task-specific input |
| --- | --- |
| `assign_roles` | `main`, `supervisor` |
| `delegate` | `target`, `goal`, `acceptance`, `read_paths`, `write_paths`, `deadline_at` |
| `supervise` | `task_id`, exact `run` identity, `supervisor`, `interval_seconds`, `deadline_at`, `repair_paths` |
| `recover` | Original `message_id` |
| `return` | `task_id` |
| `cancel_pending` | `task_id`, optional `stop_supervision` |

The request schema in [request.ts](https://github.com/elan6666/Session-bridge/blob/main/src/cli/request.ts) defines the exact fields and selector shapes. Obtain deadlines from the actual task; do not copy a stale timestamp.

## Reports, runs, and verification

| Entry | JSON fields |
| --- | --- |
| `report --stdin` | `task_id`, `summary`, `artifact_paths` |
| `return --stdin` | `task_id`, `request_id` |
| `run --stdin` | `argv`, `source_commit`, `config_sha256`; optional `config_file`, `artifacts`, `run_id` |
| `supervise --stdin` with a saved run file | `request_id`, `task_id`, `run_file`, `supervisor_query`, `interval_seconds`, `deadline_at`, `repair_paths` |
| `acknowledge --stdin` | `task_id`, `action`; extra fields depend on `receive`, `plan_next`, `verify`, or `continue` |
| `action --action-id ID --stdin` | `task_id`, `purpose`, `argv`, `artifact_paths`; continuation also requires `next_action_id` |

The bridge calculates artifact hashes from actual files within the permitted scope. A valid terminal report may automatically prepare the handback and return it; a separate return operation supports reconciliation.

`run` captures a real process identity and terminal receipt without automatically restarting the job. `cancel` does not kill that independent process.

Native action verification currently focuses on the original Codex main session. `purpose` is `verification` or `continuation`. Keep a stable action ID; reconciliation may remain pending until the native command finishes and its history is available. See [compatibility](support.en.md).

## MCP and native tools

MCP exposes the same core operations; schemas are defined in [server.ts](https://github.com/elan6666/Session-bridge/blob/main/src/mcp/server.ts). Shared Codex MCP without trusted source identity refuses writes, so use the original-chat CLI route when required.

Each app's native plugin syntax differs. Follow [sessionbridge-do](../skills/sessionbridge-do/SKILL.md) and the actual tool schema rather than assuming one argument format works everywhere.

## Installation and removal

```bash
session-bridge install --harness claude --scope project --project /absolute/path/to/project --dry-run
session-bridge install --harness claude --scope project --project /absolute/path/to/project
session-bridge uninstall --receipt /absolute/path/to/install-receipt.json
```

Installation returns `enabled:false` and activation instructions. Upgrade/removal preserves user edits and unrelated configuration; conflicts require user resolution. Removing an npm prefix is a separate action from removing integration files.
