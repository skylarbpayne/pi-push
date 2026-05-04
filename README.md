# pi-push

`pi-push` is a Pi extension that hands the current Pi session to another machine over SSH. It copies the session file, prepares matching git worktrees on the remote host, and starts Pi there in a detached tmux session.

It is meant for moving active work between machines without overwriting an existing checkout on the remote host.

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
    "tmuxPrefix": "pi-push",
    "command": null
  },
  "continuationPrompt": "Continue this work from the pushed laptop session. Verify repo state before making changes."
}
```

Add config when you need path mappings, different directories, a custom tmux prefix, or a default prompt. Create `~/.pi/agent/pi-push.json`:

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
        "tmuxPrefix": "pi-push",
        "command": null
      },
      "continuationPrompt": "Continue this work from the pushed laptop session. Verify repo state before making changes."
    }
  }
}
```

Project config in `.pi/pi-push.json` overrides global config. Nested `pathMappings` and `launch` values are merged.

Without a path mapping, repos are placed under `remoteRoot` by repo name. For example, `/Users/you/src/app` maps to `~/code/app`.

### Custom launch command

By default, `pi-push` installs a small runner script on the remote host and starts Pi in detached tmux with `nohup`, so the local `/push` command returns immediately.

Set `launch.command` to run your own launch command instead. The command may use these templates:

- `{{remoteCwd}}`
- `{{sessionFile}}`
- `{{prompt}}`
- `{{tmuxSession}}`

Template values are shell-quoted before substitution.

## Use

```text
/push beelink
```

If exactly one host is configured, `/push` uses it.

Override the continuation prompt for one push:

```text
/push beelink --prompt "Continue from here and focus on the failing tests."
```

Preview the plan without copying sessions, pushing branches, or changing the remote host:

```text
/push beelink --dry-run
```

The command:

1. Waits for the current Pi turn to finish.
2. Copies the current Pi session JSONL file to the remote host.
3. Infers git repos from the current working directory and file paths in the session.
4. For each repo, either checks out the current branch remotely or creates a handoff branch when local work needs to move.
5. Prepares a remote git worktree for each repo.
6. Starts Pi on the remote host with the copied session and continuation prompt, then disconnects the local command.

When a repo is dirty, has unpushed commits, or has no upstream, `pi-push` creates `pi-handoff/<session-prefix>`, commits all non-ignored changes to it, and pushes it to `origin`. This switches your local checkout to the handoff branch.

On the remote host, `pi-push` creates or updates `pi-push/<session-prefix>` from the source branch and uses a separate worktree. For a repo mapped to `/home/skylar/code/app`, the pushed session uses a worktree like:

```text
/home/skylar/code/app.pi-worktrees/<session-prefix>
```

The remote tmux session is named `<tmuxPrefix>-<short-session-id>`, for example `pi-push-a1b2c3d4`. After launch, attach with:

```bash
ssh beelink -t tmux attach -t pi-push-a1b2c3d4
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
- `node` for the default remote runner

If the remote is missing `git`, `tmux`, or `pi`, `pi-push` offers to install them. It supports `apt`, `dnf`, `yum`, `pacman`, `apk`, and Homebrew for `git` and `tmux`. It installs Pi with:

```bash
npm install -g @mariozechner/pi-coding-agent
```

If the remote lacks `npm`, install Node.js first. The runner looks for `pi` on `PATH`, in the global npm prefix, and in common `mise` Node installs.

## Safety

`pi-push` refuses to continue when:

- the current Pi session is not persisted
- SSH is unreachable
- the remote is missing `git`, `tmux`, or `pi` and automatic install is unavailable or declined
- a local repo is detached
- a local repo is in the middle of a rebase, merge, cherry-pick, or conflict
- a remote pushed worktree has dirty changes
- a mapped remote repo path exists but is not a git repo
- a path cannot be mapped to the remote machine
- a push, fetch, checkout, or launch step fails

It includes untracked files in handoff commits. It does not include ignored files. It does not force-push, run `git reset --hard`, or check out over the remote's normal working tree.

## Cleanup

Remote worktrees are ordinary git worktrees:

```bash
git -C /home/skylar/code/app worktree remove /home/skylar/code/app.pi-worktrees/<session-prefix>
```

Local and remote handoff branches are ordinary git branches:

```bash
git branch -D pi-handoff/<session-prefix>
git push origin --delete pi-handoff/<session-prefix>
```

Remote working branches live only on the remote clone unless you push them:

```bash
git -C /home/skylar/code/app branch -D pi-push/<session-prefix>
```
