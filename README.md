# pi-push

`pi-push` is a Pi extension that pushes the current Pi session to another machine over SSH and starts Pi there. It can also move git work by creating and pushing a temporary handoff branch.

## Install

```bash
pi install git:github.com/skylarbpayne/pi-push
```

For local development:

```bash
pi -e /path/to/pi-push
```

## Configure

Configuration is optional. If you run `/push beelink` and `beelink` is an SSH alias, `pi-push` uses these defaults:

```json
{
  "ssh": "beelink",
  "remoteRoot": "~/code",
  "remoteSessionDir": "~/.pi/agent/sessions/pushed",
  "launch": {
    "mode": "tmux-session",
    "tmuxPrefix": "pi-push"
  }
}
```

Add config when you need path mappings or different directories. Create `~/.pi/agent/pi-push.json`:

```json
{
  "hosts": {
    "beelink": {
      "ssh": "beelink",
      "remoteRoot": "/home/skylar/code",
      "pathMappings": {
        "/Users/skylarbpayne": "/home/skylar"
      },
      "remoteSessionDir": "~/.pi/agent/sessions/pushed",
      "launch": {
        "mode": "tmux-session",
        "tmuxPrefix": "pi-push"
      },
      "continuationPrompt": "Continue this work from the pushed laptop session. Verify repo state before making changes."
    }
  }
}
```

Project config in `.pi/pi-push.json` overrides global config.

Without a path mapping, repos are placed under `remoteRoot` by repo name. For example, `/Users/you/src/app` maps to `~/code/app`.

## Use

```text
/push beelink
```

If only one host is configured, `/push` uses it.

The command:

1. Copies the current Pi session JSONL file to the remote host.
2. Infers git repos from the current session and working directory.
3. Creates and pushes `pi-handoff/<session-id>` when a repo has dirty or local-only work.
4. Prepares a remote git worktree for each repo.
5. Starts Pi in a detached tmux session with a continuation prompt.

Remote worktrees keep `pi-push` from clobbering an existing checkout. For a repo mapped to `/home/skylar/code/app`, the pushed session uses a worktree like:

```text
/home/skylar/code/app.pi-worktrees/<session-id>
```

Use dry-run mode to see the plan without changing anything:

```text
/push beelink --dry-run
```

## Requirements

Local machine:

- `ssh`
- `scp`
- `git`

Remote machine:

- key-based SSH access
- `git`
- `tmux`
- `pi`

## Safety

`pi-push` refuses to continue when:

- the current Pi session is ephemeral
- SSH is unreachable
- the remote is missing `git`, `tmux`, or `pi`
- a local repo is in the middle of a rebase, merge, or conflict
- a remote pushed worktree has dirty changes
- a path cannot be mapped to the remote machine
- a push or checkout fails

It includes untracked files in handoff commits. It does not include ignored files. It does not force-push, run `git reset --hard`, or check out over the remote's normal working tree.

## Cleanup

Remote worktrees are ordinary git worktrees:

```bash
git -C /home/skylar/code/app worktree remove /home/skylar/code/app.pi-worktrees/<session-id>
```

Handoff branches are ordinary git branches:

```bash
git branch -D pi-handoff/<session-id>
git branch -D pi-push/<session-id>
git push origin --delete pi-handoff/<session-id>
```
