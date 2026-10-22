# Compatibility and limits

[English](support.en.md) · [简体中文](support.md) · [Back to README](../README.md)

SessionBridge 0.1 is a local session-integration prototype. Connection, delivery, model execution, and task acceptance are separate states. Check the app version, session mode, and actual task requirements independently.

## Runtime requirements

- The core requires Node.js ≥24.15.0 and <25. The local transport targets macOS/Linux; Windows integration is unverified.
- Each participating conversation must enroll from its original app. Some apps require explicit plugin activation or extension reload.
- Periodic supervision requires the project's coordination service to remain running. Machine sleep pauses local services and jobs; checks continue after waking, without a guarantee of immediate response or automatic app restart.
- Accounts, model access, and tool permissions remain under each original app's control.

## App connections

| App | Integration | Conditions |
| --- | --- | --- |
| Codex | Original-chat connect, matching desktop native queue and read-only history | Interface version 0.163.0-alpha.11. The desktop remains the only executor. Archived, unloaded, or closed chats are not guaranteed to wake. Revalidate after upgrades. |
| Claude Code | Native plugin lifecycle and later inbox | Adapted to 2.1.306. Activate the plugin in the original app; Claude controls tool permissions. |
| Pi | Native extension and followUp | Adapted to 1.3.0. Switching or reloading a session invalidates the old connection. Delivery does not interrupt execution. |
| dsh | Web/Desktop Cordis plugin bound to the original Agent | Adapted to 0.2.1-rc.2. Web mode has the clearer integration scope; individual desktop instances need separate checks. Entry syntax follows the original app. |
| Hermes | Native plugin and canonical gateway TUI queue | Busy injection in the ordinary CLI is restricted. Desktop GUI attachment is unverified. |

Versions identify interface adaptation conditions, not an instruction to upgrade. Plugin installation does not restart applications or take over other conversations. Attaching an existing session and launching a new managed worker are distinct modes.

## Tasks and recovery

- Keep the original message ID when delivery is uncertain and use recover to reconcile. Do not blindly retry under a new ID or channel.
- The service records task scope, run identity, artifact hashes, and returns. A process exit or assistant reply alone does not establish acceptance.
- The original main conversation must verify actual results. Generic native-command action proofs currently focus on Codex; equivalent guarantees are not claimed for other apps.
- cancel stops future delivery or supervision, not independent jobs.
- Scope checks help prevent misrouting and incorrect attribution. They are not a security sandbox against arbitrary programs running as the same OS user.

## Optional project management integration

Ordinary projects use standalone task mode. Existing Byte projects retain their authoritative state; the bridge manages transport, scheduling, and reporting. The pinned Byte helper supports Codex, Claude, dsh, and ZCode; Byte handoffs involving Pi/Hermes return an explicit restricted state. App integration in standalone mode does not imply Byte integration support.
