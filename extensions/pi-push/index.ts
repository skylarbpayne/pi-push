import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";

type LaunchConfig = {
	mode?: "tmux-session";
	tmuxPrefix?: string;
	command?: string | null;
};

type HostConfig = {
	ssh: string;
	remoteRoot?: string;
	pathMappings?: Record<string, string>;
	remoteSessionDir?: string;
	launch?: LaunchConfig;
	continuationPrompt?: string;
};

type PushConfig = { hosts?: Record<string, HostConfig> };

type ExecResult = { stdout: string; stderr: string; code: number | null; killed?: boolean };

type RepoPlan = {
	localRoot: string;
	remoteRoot: string;
	remoteWorktree: string;
	remoteUrl: string;
	branch: string;
	remoteBranch: string;
	handoffBranch?: string;
	dirty: boolean;
	ahead: number;
	action: "checkout" | "handoff";
};

type PushPlan = {
	hostName: string;
	host: Required<HostConfig>;
	sessionFile: string;
	sessionCopyFile: string;
	sessionId: string;
	shortSessionId: string;
	remoteSessionFile: string;
	remoteCwd: string;
	repos: RepoPlan[];
	tmuxSession: string;
	dryRun: boolean;
};

const DEFAULT_CONFIG: Required<Omit<HostConfig, "ssh">> = {
	remoteRoot: "~/code",
	pathMappings: {},
	remoteSessionDir: "~/.pi/agent/sessions/pushed",
	launch: { mode: "tmux-session", tmuxPrefix: "pi-push", command: null },
	continuationPrompt: "Continue this work from the pushed laptop session. Verify repo state before making changes.",
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("push", {
		description: "Push the current Pi session to another machine over SSH",
		handler: async (args, ctx) => {
			try {
				await ctx.waitForIdle();
				const parsedArgs = parseArgs(args);
				const config = await loadConfig(ctx.cwd);
				const { hostName, host } = resolveHost(config, parsedArgs.hostArg);
				if (parsedArgs.prompt) host.continuationPrompt = parsedArgs.prompt;

				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("This Pi session is not persisted. Start Pi without --no-session, then try again.");

				ctx.ui.notify(`Planning push to ${hostName}...`, "info");
				await checkLocalPrereqs(pi);
				await ensureRemotePrereqs(pi, ctx, host.ssh);

				const plan = await buildPlan(pi, ctx, hostName, host, sessionFile, parsedArgs.dryRun);
				if (!(await confirmPlan(ctx, plan))) return;

				if (parsedArgs.dryRun) {
					showPlan(ctx, plan);
					return;
				}

				await executePlan(pi, ctx, plan);
				ctx.ui.notify(`Pushed to ${hostName}. tmux: ${plan.tmuxSession}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

async function loadConfig(cwd: string): Promise<PushConfig> {
	const globalPath = join(homedir(), ".pi", "agent", "pi-push.json");
	const projectPath = join(cwd, ".pi", "pi-push.json");
	return mergeConfig(await readJson(globalPath), await readJson(projectPath));
}

async function readJson(path: string): Promise<PushConfig> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function mergeConfig(...configs: PushConfig[]): PushConfig {
	const out: PushConfig = { hosts: {} };
	for (const config of configs) {
		for (const [name, host] of Object.entries(config.hosts ?? {})) {
			out.hosts![name] = {
				...(out.hosts![name] ?? {}),
				...host,
				pathMappings: { ...(out.hosts![name]?.pathMappings ?? {}), ...(host.pathMappings ?? {}) },
				launch: { ...(out.hosts![name]?.launch ?? {}), ...(host.launch ?? {}) },
			};
		}
	}
	return out;
}

type ParsedArgs = { hostArg: string; dryRun: boolean; prompt?: string };

function parseArgs(args: string): ParsedArgs {
	const tokens = shellSplit(args);
	let hostArg = "";
	let dryRun = false;
	let prompt: string | undefined;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--dry-run") {
			dryRun = true;
		} else if (token === "--prompt") {
			prompt = tokens[++i];
			if (!prompt) throw new Error('Usage: /push <host> --prompt "continuation prompt"');
		} else if (token.startsWith("--prompt=")) {
			prompt = token.slice("--prompt=".length);
			if (!prompt) throw new Error('Usage: /push <host> --prompt "continuation prompt"');
		} else if (token.startsWith("--")) {
			throw new Error(`Unknown option: ${token}`);
		} else if (!hostArg) {
			hostArg = token;
		} else {
			throw new Error(`Unexpected argument: ${token}. Use --prompt for continuation text.`);
		}
	}

	return { hostArg, dryRun, prompt };
}

function shellSplit(input: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: '"' | "'" | null = null;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			token += char;
			escaping = false;
		} else if (char === "\\" && quote !== "'") {
			escaping = true;
		} else if (quote) {
			if (char === quote) quote = null;
			else token += char;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (/\s/.test(char)) {
			if (token) {
				tokens.push(token);
				token = "";
			}
		} else {
			token += char;
		}
	}

	if (escaping) token += "\\";
	if (quote) throw new Error("Unclosed quote in /push arguments.");
	if (token) tokens.push(token);
	return tokens;
}

function resolveHost(config: PushConfig, hostArg: string): { hostName: string; host: Required<HostConfig> } {
	const hosts = config.hosts ?? {};
	const names = Object.keys(hosts);
	const hostName = hostArg || (names.length === 1 ? names[0] : "");
	if (!hostName) throw new Error("Usage: /push <host>. No host was provided and multiple or no hosts are configured.");
	const raw = hosts[hostName] ?? { ssh: hostName };
	if (!hosts[hostName]) {
		console.warn(`pi-push: no config for ${hostName}; using SSH alias defaults.`);
	}
	return {
		hostName,
		host: {
			ssh: raw.ssh,
			remoteRoot: raw.remoteRoot ?? DEFAULT_CONFIG.remoteRoot,
			pathMappings: raw.pathMappings ?? {},
			remoteSessionDir: raw.remoteSessionDir ?? DEFAULT_CONFIG.remoteSessionDir,
			launch: { ...DEFAULT_CONFIG.launch, ...(raw.launch ?? {}) },
			continuationPrompt: raw.continuationPrompt ?? DEFAULT_CONFIG.continuationPrompt,
		},
	};
}

async function checkLocalPrereqs(pi: ExtensionAPI) {
	for (const cmd of ["ssh", "scp", "git"]) {
		await run(pi, "bash", ["-lc", `command -v ${cmd} >/dev/null`], `Missing required command: ${cmd}`);
	}
}

async function ensureRemotePrereqs(pi: ExtensionAPI, ctx: any, ssh: string) {
	const missing = await getMissingRemoteCommands(pi, ssh, ["git", "tmux", "pi"]);
	if (missing.length === 0) return;

	const installPlan = await getRemoteInstallPlan(pi, ssh, missing);
	if (!installPlan) {
		throw new Error(`Remote is missing ${missing.join(", ")}. Install them on ${ssh}, then try again.`);
	}

	if (!ctx.hasUI) {
		throw new Error(`Remote is missing ${missing.join(", ")}. Run interactively to approve automatic install, or install them manually.`);
	}

	const ok = await ctx.ui.confirm(
		"Install remote dependencies?",
		[`Remote ${ssh} is missing: ${missing.join(", ")}`, "", "pi-push can run:", installPlan.command, "", "Continue?"].join("\n"),
	);
	if (!ok) throw new Error(`Remote is missing ${missing.join(", ")}.`);

	await remoteBash(pi, ssh, installPlan.command, `Could not install remote dependencies on ${ssh}.`);
	const stillMissing = await getMissingRemoteCommands(pi, ssh, ["git", "tmux", "pi"]);
	if (stillMissing.length > 0) throw new Error(`Remote is still missing ${stillMissing.join(", ")} after install.`);
}

async function getMissingRemoteCommands(pi: ExtensionAPI, ssh: string, commands: string[]): Promise<string[]> {
	const script = commands.map((cmd) => `${remoteCommandExists(cmd)} || printf '%s\\n' ${q(cmd)}`).join("\n");
	const result = await remoteBash(pi, ssh, script, `Could not check remote dependencies on ${ssh}.`);
	return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

type RemoteInstallPlan = { command: string };

async function getRemoteInstallPlan(pi: ExtensionAPI, ssh: string, missing: string[]): Promise<RemoteInstallPlan | null> {
	const probe = `
set -e
if command -v apt-get >/dev/null; then echo apt; exit 0; fi
if command -v dnf >/dev/null; then echo dnf; exit 0; fi
if command -v yum >/dev/null; then echo yum; exit 0; fi
if command -v pacman >/dev/null; then echo pacman; exit 0; fi
if command -v apk >/dev/null; then echo apk; exit 0; fi
if command -v brew >/dev/null; then echo brew; exit 0; fi
echo none
`;
	const manager = (await remoteBash(pi, ssh, probe, `Could not detect package manager on ${ssh}.`)).stdout.trim();
	const packages = missing.filter((cmd) => cmd !== "pi");
	const commands: string[] = [];

	if (packages.length > 0) {
		const packageList = packages.map(q).join(" ");
		if (manager === "apt") commands.push(`sudo apt-get update && sudo apt-get install -y ${packageList}`);
		else if (manager === "dnf") commands.push(`sudo dnf install -y ${packageList}`);
		else if (manager === "yum") commands.push(`sudo yum install -y ${packageList}`);
		else if (manager === "pacman") commands.push(`sudo pacman -Sy --needed --noconfirm ${packageList}`);
		else if (manager === "apk") commands.push(`sudo apk add ${packageList}`);
		else if (manager === "brew") commands.push(`brew install ${packageList}`);
		else return null;
	}

	if (missing.includes("pi")) {
		const hasNpm = (await remoteBash(pi, ssh, "command -v npm >/dev/null && echo yes || echo no", `Could not check npm on ${ssh}.`)).stdout.trim() === "yes";
		if (!hasNpm) return null;
		commands.push("npm install -g @mariozechner/pi-coding-agent");
	}

	return { command: commands.join(" && ") };
}

async function buildPlan(pi: ExtensionAPI, ctx: any, hostName: string, host: Required<HostConfig>, sessionFile: string, dryRun: boolean): Promise<PushPlan> {
	const remoteHome = (await remoteBash(pi, host.ssh, "printf %s \"$HOME\"", "Could not resolve remote home directory.")).stdout.trim();
	const expandedHost = expandHostRemotePaths(host, remoteHome);
	const sessionSnapshot = await getSessionSnapshot(ctx, sessionFile);
	const sessionId = sessionSnapshot.sessionId;
	const shortSessionId = sessionId.slice(0, 8);
	const remoteSessionFile = `${trimSlash(expandedHost.remoteSessionDir)}/${basenameNoExt(sessionFile)}-${shortSessionId}.jsonl`;
	const repos = await inferRepos(pi, ctx, expandedHost, sessionId);
	const remoteCwd = mapIntoRemoteWorktree(ctx.cwd, repos) ?? mapPath(ctx.cwd, expandedHost);
	return {
		hostName,
		host: expandedHost,
		sessionFile,
		sessionCopyFile: sessionSnapshot.file,
		sessionId,
		shortSessionId,
		remoteSessionFile,
		remoteCwd,
		repos,
		tmuxSession: `${host.launch.tmuxPrefix ?? "pi-push"}-${shortSessionId}`,
		dryRun,
	};
}

async function getSessionSnapshot(ctx: any, sessionFile: string): Promise<{ file: string; sessionId: string }> {
	if (existsSync(sessionFile)) {
		const header = JSON.parse((await readFile(sessionFile, "utf8")).split("\n", 1)[0] ?? "{}");
		return { file: sessionFile, sessionId: String(header.id ?? ctx.sessionManager.getSessionId?.() ?? basenameNoExt(sessionFile)) };
	}

	const header = ctx.sessionManager.getHeader?.() ?? {
		type: "session",
		version: 3,
		id: ctx.sessionManager.getSessionId?.() ?? basenameNoExt(sessionFile),
		timestamp: new Date().toISOString(),
		cwd: ctx.cwd,
	};
	const entries = ctx.sessionManager.getEntries?.() ?? [];
	const dir = await mkdtemp(join(tmpdir(), "pi-push-session-"));
	const file = join(dir, basenameNoExt(sessionFile) + ".jsonl");
	await writeFile(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
	return { file, sessionId: String(header.id ?? basenameNoExt(sessionFile)) };
}

async function inferRepos(pi: ExtensionAPI, ctx: any, host: Required<HostConfig>, sessionId: string): Promise<RepoPlan[]> {
	const candidates = new Set<string>([ctx.cwd]);
	for (const entry of ctx.sessionManager.getBranch() as SessionEntry[]) collectEntryPaths(entry, ctx.cwd, candidates);

	const roots = new Set<string>();
	for (const candidate of candidates) {
		const dir = existingDir(candidate);
		if (!dir) continue;
		const result = await pi.exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
		if (result.code === 0 && result.stdout.trim()) roots.add(result.stdout.trim());
	}

	const plans: RepoPlan[] = [];
	for (const root of roots) plans.push(await planRepo(pi, root, host, sessionId));
	return plans;
}

function collectEntryPaths(entry: SessionEntry, cwd: string, out: Set<string>) {
	if (entry.type !== "message") return;
	const message: any = entry.message;
	if (message.role === "assistant" && Array.isArray(message.content)) {
		for (const block of message.content) {
			if (block?.type !== "toolCall") continue;
			const args = block.arguments ?? {};
			for (const key of ["path", "file", "cwd", "directory"]) addPath(args[key], cwd, out);
			if (Array.isArray(args.paths)) for (const path of args.paths) addPath(path, cwd, out);
		}
	}
	if (message.role === "toolResult") {
		const details = message.details ?? {};
		for (const key of ["path", "cwd", "file"]) addPath(details[key], cwd, out);
	}
}

function addPath(value: unknown, cwd: string, out: Set<string>) {
	if (typeof value !== "string" || !value.trim()) return;
	out.add(isAbsolute(value) ? value : resolve(cwd, value));
}

async function planRepo(pi: ExtensionAPI, root: string, host: Required<HostConfig>, sessionId: string): Promise<RepoPlan> {
	await ensureRepoSafe(pi, root);
	const branch = (await git(pi, root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
	if (branch === "HEAD") throw new Error(`Repo is detached; cannot push safely: ${root}`);
	const remoteUrl = (await git(pi, root, ["remote", "get-url", "origin"])).stdout.trim();
	const dirty = (await git(pi, root, ["status", "--porcelain"])).stdout.trim().length > 0;
	const ahead = await aheadCount(pi, root);
	const action = dirty || ahead > 0 ? "handoff" : "checkout";
	const remoteRoot = mapPath(root, host);
	return {
		localRoot: root,
		remoteRoot,
		remoteWorktree: `${remoteRoot}.pi-worktrees/${sessionId.slice(0, 12)}`,
		remoteUrl,
		branch,
		remoteBranch: `pi-push/${sessionId.slice(0, 12)}`,
		handoffBranch: action === "handoff" ? `pi-handoff/${sessionId.slice(0, 12)}` : undefined,
		dirty,
		ahead,
		action,
	};
}

async function ensureRepoSafe(pi: ExtensionAPI, root: string) {
	const gitDir = (await git(pi, root, ["rev-parse", "--git-dir"])).stdout.trim();
	const absoluteGitDir = isAbsolute(gitDir) ? gitDir : join(root, gitDir);
	for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
		if (existsSync(join(absoluteGitDir, marker))) throw new Error(`Repo has an in-progress operation: ${root}`);
	}
	const conflicts = (await git(pi, root, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim();
	if (conflicts) throw new Error(`Repo has merge conflicts: ${root}`);
}

async function aheadCount(pi: ExtensionAPI, root: string): Promise<number> {
	const upstream = await pi.exec("git", ["-C", root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	if (upstream.code !== 0) return 1;
	const count = await git(pi, root, ["rev-list", "--count", `${upstream.stdout.trim()}..HEAD`]);
	return Number.parseInt(count.stdout.trim() || "0", 10);
}

async function confirmPlan(ctx: any, plan: PushPlan): Promise<boolean> {
	const needsConfirm = plan.repos.length > 1 || plan.repos.some((repo) => repo.action === "handoff");
	if (!needsConfirm || !ctx.hasUI) return true;
	const lines = [
		`Push session to ${plan.hostName}?`,
		`Session: ${plan.remoteSessionFile}`,
		"",
		...plan.repos.map((repo) => `- ${repo.action}: ${repo.localRoot} -> ${repo.remoteWorktree}${repo.handoffBranch ? ` (${repo.handoffBranch})` : ` (${repo.branch})`}`),
	];
	return await ctx.ui.confirm("Confirm pi-push", lines.join("\n"));
}

function showPlan(ctx: any, plan: PushPlan) {
	ctx.ui.notify(`Dry run: would push to ${plan.hostName}; repos: ${plan.repos.length}; tmux: ${plan.tmuxSession}`, "info");
	console.log(JSON.stringify(plan, null, 2));
}

async function executePlan(pi: ExtensionAPI, ctx: any, plan: PushPlan) {
	await copySession(pi, plan);
	for (const repo of plan.repos) {
		ctx.ui.notify(`${repo.action === "handoff" ? "Handing off" : "Checking out"}: ${repo.localRoot}`, "info");
		if (repo.action === "handoff") await createAndPushHandoff(pi, repo, plan.sessionId);
		await prepareRemoteRepo(pi, plan.host.ssh, repo);
	}
	await launchRemote(pi, plan);
}

async function copySession(pi: ExtensionAPI, plan: PushPlan) {
	await remoteBash(pi, plan.host.ssh, `mkdir -p ${q(dirname(plan.remoteSessionFile))}`, "Could not create remote session directory.");
	await run(pi, "scp", [plan.sessionCopyFile, `${plan.host.ssh}:${plan.remoteSessionFile}`], "Could not copy session file.");
}

async function createAndPushHandoff(pi: ExtensionAPI, repo: RepoPlan, sessionId: string) {
	const branch = repo.handoffBranch!;
	const current = (await git(pi, repo.localRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
	if (current !== branch) {
		const exists = await pi.exec("git", ["-C", repo.localRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
		await git(pi, repo.localRoot, exists.code === 0 ? ["switch", branch] : ["switch", "-c", branch]);
	}
	await git(pi, repo.localRoot, ["add", "-A"]);
	const staged = (await git(pi, repo.localRoot, ["diff", "--cached", "--name-only"])).stdout.trim();
	if (staged) await git(pi, repo.localRoot, ["commit", "-m", `pi handoff: ${sessionId.slice(0, 12)}`]);
	await git(pi, repo.localRoot, ["push", "-u", "origin", branch]);
}

async function prepareRemoteRepo(pi: ExtensionAPI, ssh: string, repo: RepoPlan) {
	const sourceBranch = repo.handoffBranch ?? repo.branch;
	const parent = dirname(repo.remoteRoot);
	const worktreeParent = dirname(repo.remoteWorktree);
	const script = `
set -e
if [ ! -d ${q(repo.remoteRoot)} ]; then
  mkdir -p ${q(parent)}
  git clone ${q(repo.remoteUrl)} ${q(repo.remoteRoot)}
elif [ ! -d ${q(`${repo.remoteRoot}/.git`)} ] && ! git -C ${q(repo.remoteRoot)} rev-parse --git-dir >/dev/null 2>&1; then
  echo "Remote repo path exists but is not a git repo: ${repo.remoteRoot}" >&2
  exit 2
fi
cd ${q(repo.remoteRoot)}
git fetch origin ${q(`${sourceBranch}:refs/remotes/origin/${sourceBranch}`)}
mkdir -p ${q(worktreeParent)}
if [ -d ${q(repo.remoteWorktree)} ]; then
  cd ${q(repo.remoteWorktree)}
  if [ -n "$(git status --porcelain)" ]; then
    echo "Remote worktree has dirty changes: ${repo.remoteWorktree}" >&2
    exit 2
  fi
  git fetch origin ${q(`${sourceBranch}:refs/remotes/origin/${sourceBranch}`)}
  git switch ${q(repo.remoteBranch)}
  git merge --ff-only ${q(`origin/${sourceBranch}`)}
else
  git branch -f ${q(repo.remoteBranch)} ${q(`origin/${sourceBranch}`)}
  git worktree add ${q(repo.remoteWorktree)} ${q(repo.remoteBranch)}
fi
`;
	await remoteBash(pi, ssh, script, `Could not prepare remote worktree: ${repo.remoteWorktree}`);
}

async function launchRemote(pi: ExtensionAPI, plan: PushPlan) {
	const runnerDir = `${dirname(plan.remoteSessionFile)}/../pi-push`;
	const runnerPath = `${runnerDir}/run-session.sh`;
	const planPath = `${runnerDir}/plans/${plan.shortSessionId}.json`;
	const launchPlan = {
		tmuxSession: plan.tmuxSession,
		cwd: plan.remoteCwd,
		sessionFile: plan.remoteSessionFile,
		prompt: plan.host.continuationPrompt,
		logFile: `${runnerDir}/logs/${plan.tmuxSession}.log`,
	};

	if (plan.host.launch.command) {
		await remoteBash(
			pi,
			plan.host.ssh,
			renderTemplate(plan.host.launch.command, { remoteCwd: plan.remoteCwd, sessionFile: plan.remoteSessionFile, prompt: plan.host.continuationPrompt, tmuxSession: plan.tmuxSession }),
			"Could not launch remote Pi.",
		);
		return;
	}

	await installRemoteRunner(pi, plan.host.ssh, runnerDir, runnerPath);
	await writeRemoteFile(pi, plan.host.ssh, planPath, JSON.stringify(launchPlan, null, 2));
	const launchLog = `${runnerDir}/logs/${plan.tmuxSession}-launch.log`;
	await remoteBash(
		pi,
		plan.host.ssh,
		`nohup ${q(runnerPath)} ${q(planPath)} > ${q(launchLog)} 2>&1 < /dev/null &`,
		"Could not start remote Pi launcher.",
	);
	console.log(`Started remote launcher for tmux session: ${plan.tmuxSession}`);
	console.log(`Attach: ssh ${plan.host.ssh} -t tmux attach -t ${plan.tmuxSession}`);
	console.log(`Launch log: ${launchLog}`);
}

async function installRemoteRunner(pi: ExtensionAPI, ssh: string, runnerDir: string, runnerPath: string) {
	await remoteBash(pi, ssh, `mkdir -p ${q(runnerDir)} ${q(`${runnerDir}/plans`)} ${q(`${runnerDir}/logs`)}`, "Could not create remote runner directory.");
	await writeRemoteFile(pi, ssh, runnerPath, REMOTE_RUNNER);
	await remoteBash(pi, ssh, `chmod +x ${q(runnerPath)}`, "Could not mark remote runner executable.");
}

async function writeRemoteFile(pi: ExtensionAPI, ssh: string, path: string, content: string) {
	const encoded = Buffer.from(content, "utf8").toString("base64");
	await remoteBash(pi, ssh, `mkdir -p ${q(dirname(path))} && base64 -d > ${q(path)} <<'PI_PUSH_EOF'\n${encoded}\nPI_PUSH_EOF`, `Could not write remote file: ${path}`);
}

const REMOTE_RUNNER = `#!/usr/bin/env bash
set -euo pipefail

plan_file="\${1:-}"
if [ -z "$plan_file" ] || [ ! -f "$plan_file" ]; then
  echo "Usage: $0 <launch-plan.json>" >&2
  exit 2
fi

json_get() {
  node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(p[process.argv[2]] || '')" "$plan_file" "$1"
}

load_env() {
  [ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1 || true
  [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 || true
  if [ -x "$HOME/.local/bin/mise" ]; then eval "$($HOME/.local/bin/mise activate bash)" >/dev/null 2>&1 || true; fi
  if command -v mise >/dev/null 2>&1; then eval "$(mise activate bash)" >/dev/null 2>&1 || true; fi
}

find_pi() {
  command -v pi 2>/dev/null && return 0
  if command -v npm >/dev/null 2>&1; then
    local npm_pi="$(npm prefix -g 2>/dev/null)/bin/pi"
    [ -x "$npm_pi" ] && printf '%s\\n' "$npm_pi" && return 0
  fi
  if command -v mise >/dev/null 2>&1; then
    local mise_pi="$(mise where node 2>/dev/null)/bin/pi"
    [ -x "$mise_pi" ] && printf '%s\\n' "$mise_pi" && return 0
  fi
  for mise_pi in "$HOME"/.local/share/mise/installs/node/*/bin/pi; do
    [ -x "$mise_pi" ] && printf '%s\\n' "$mise_pi" && return 0
  done
  return 1
}

load_env

tmux_session="$(json_get tmuxSession)"
cwd="$(json_get cwd)"
session_file="$(json_get sessionFile)"
prompt="$(json_get prompt)"
log_file="$(json_get logFile)"
launch_log="$(dirname "$log_file")/$tmux_session-launch.log"
pi_path="$(find_pi)" || { echo "Could not find pi. Install pi or add it to PATH." >&2; exit 1; }

mkdir -p "$(dirname "$log_file")"
{
  echo "plan_file=$plan_file"
  echo "tmux_session=$tmux_session"
  echo "cwd=$cwd"
  echo "session_file=$session_file"
  echo "pi_path=$pi_path"
  echo "log_file=$log_file"
  date
} > "$launch_log"

if tmux has-session -t "$tmux_session" 2>/dev/null; then
  echo "Pi session already exists: $tmux_session"
  echo "Attach: tmux attach -t $tmux_session"
  echo "Launch log: $launch_log"
  exit 0
fi

if [ ! -d "$cwd" ]; then
  echo "Remote cwd does not exist: $cwd" | tee -a "$launch_log" >&2
  exit 1
fi

tmux new-session -d -s "$tmux_session" "cd '$cwd' && '$pi_path' --session '$session_file' '$prompt' 2>&1 | tee '$log_file'; exec bash"
tmux has-session -t "$tmux_session" 2>/dev/null || { echo "tmux session failed to start: $tmux_session" | tee -a "$launch_log" >&2; exit 1; }

echo "Started Pi in tmux session: $tmux_session"
echo "Attach: tmux attach -t $tmux_session"
echo "Log: $log_file"
echo "Launch log: $launch_log"
`;

function renderTemplate(template: string, vars: Record<string, string>) {
	return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => q(vars[key] ?? ""));
}

function expandHostRemotePaths(host: Required<HostConfig>, remoteHome: string): Required<HostConfig> {
	const pathMappings = Object.fromEntries(
		Object.entries(host.pathMappings).map(([local, remote]) => [local, expandRemotePath(remote, remoteHome)]),
	);
	return {
		...host,
		remoteRoot: expandRemotePath(host.remoteRoot, remoteHome),
		remoteSessionDir: expandRemotePath(host.remoteSessionDir, remoteHome),
		pathMappings,
	};
}

function expandRemotePath(path: string, remoteHome: string): string {
	return path === "~" ? remoteHome : path.startsWith("~/") ? `${remoteHome}/${path.slice(2)}` : path;
}

function mapPath(localPath: string, host: Required<HostConfig>): string {
	const mappings = Object.entries(host.pathMappings).sort((a, b) => b[0].length - a[0].length);
	for (const [from, to] of mappings) {
		if (localPath === from || localPath.startsWith(`${from}/`)) return `${trimSlash(to)}${localPath.slice(from.length)}`;
	}
	if (host.remoteRoot) return `${trimSlash(host.remoteRoot)}/${localPath.split("/").filter(Boolean).pop()}`;
	throw new Error(`No remote path mapping for ${localPath}`);
}

function mapIntoRemoteWorktree(localPath: string, repos: RepoPlan[]): string | null {
	const repo = repos
		.filter((candidate) => localPath === candidate.localRoot || localPath.startsWith(`${candidate.localRoot}/`))
		.sort((a, b) => b.localRoot.length - a.localRoot.length)[0];
	if (!repo) return null;
	const suffix = relative(repo.localRoot, localPath);
	return suffix ? `${repo.remoteWorktree}/${suffix}` : repo.remoteWorktree;
}

function existingDir(path: string): string | null {
	let current = path;
	while (current !== dirname(current)) {
		if (existsSync(current)) return statSync(current).isDirectory() ? current : dirname(current);
		current = dirname(current);
	}
	return null;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<ExecResult> {
	return run(pi, "git", ["-C", cwd, ...args], `git ${args.join(" ")} failed in ${cwd}`);
}

async function remoteBash(pi: ExtensionAPI, ssh: string, script: string, message: string): Promise<ExecResult> {
	return run(pi, "ssh", [ssh, `bash -lc ${q(remoteHelpers(script))}`], message);
}

function remoteHelpers(script: string): string {
	return `
pi_command() {
  command -v pi 2>/dev/null && return 0
  if command -v npm >/dev/null 2>&1; then
    local npm_pi="$(npm prefix -g 2>/dev/null)/bin/pi"
    if [ -x "$npm_pi" ]; then printf '%s\\n' "$npm_pi"; return 0; fi
  fi
  if command -v mise >/dev/null 2>&1; then
    local mise_pi="$(mise where node 2>/dev/null)/bin/pi"
    if [ -x "$mise_pi" ]; then printf '%s\\n' "$mise_pi"; return 0; fi
  fi
  for mise_pi in "$HOME"/.local/share/mise/installs/node/*/bin/pi; do
    if [ -x "$mise_pi" ]; then printf '%s\\n' "$mise_pi"; return 0; fi
  done
  return 1
}
${script}`;
}

function remoteCommandExists(command: string): string {
	return command === "pi" ? "pi_command >/dev/null" : `command -v ${command} >/dev/null`;
}

async function run(pi: ExtensionAPI, command: string, args: string[], message: string): Promise<ExecResult> {
	const result = (await pi.exec(command, args)) as ExecResult;
	if (result.code !== 0) {
		const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
		throw new Error(detail ? `${message}\n${detail}` : message);
	}
	return result;
}

function q(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function basenameNoExt(path: string): string {
	return path.split("/").pop()?.replace(/\.jsonl$/, "") ?? "session";
}

function trimSlash(path: string): string {
	return path.replace(/\/$/, "");
}
