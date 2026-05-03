import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
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
				const dryRun = /(?:^|\s)--dry-run(?:\s|$)/.test(args);
				const hostArg = args.replace(/(?:^|\s)--dry-run(?:\s|$)/g, " ").trim();
				const config = await loadConfig(ctx.cwd);
				const { hostName, host } = resolveHost(config, hostArg);

				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("This Pi session is not persisted. Start Pi without --no-session, then try again.");

				ctx.ui.notify(`Planning push to ${hostName}...`, "info");
				await checkLocalPrereqs(pi);
				await checkRemotePrereqs(pi, host.ssh);

				const plan = await buildPlan(pi, ctx, hostName, host, sessionFile, dryRun);
				if (!(await confirmPlan(ctx, plan))) return;

				if (dryRun) {
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

function resolveHost(config: PushConfig, hostArg: string): { hostName: string; host: Required<HostConfig> } {
	const hosts = config.hosts ?? {};
	const names = Object.keys(hosts);
	const hostName = hostArg || (names.length === 1 ? names[0] : "");
	if (!hostName) throw new Error("Usage: /push <host>. No host was provided and multiple or no hosts are configured.");
	const raw = hosts[hostName];
	if (!raw) throw new Error(`Unknown push host: ${hostName}`);
	if (!raw.ssh) throw new Error(`Host ${hostName} is missing ssh config.`);
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

async function checkRemotePrereqs(pi: ExtensionAPI, ssh: string) {
	await run(pi, "ssh", [ssh, "command -v git >/dev/null && command -v tmux >/dev/null && command -v pi >/dev/null"], "Remote is missing git, tmux, or pi.");
}

async function buildPlan(pi: ExtensionAPI, ctx: any, hostName: string, host: Required<HostConfig>, sessionFile: string, dryRun: boolean): Promise<PushPlan> {
	const remoteHome = (await run(pi, "ssh", [host.ssh, "printf %s \"$HOME\""], "Could not resolve remote home directory.")).stdout.trim();
	const expandedHost = expandHostRemotePaths(host, remoteHome);
	const header = JSON.parse((await readFile(sessionFile, "utf8")).split("\n", 1)[0] ?? "{}");
	const sessionId = String(header.id ?? basenameNoExt(sessionFile));
	const shortSessionId = sessionId.slice(0, 8);
	const remoteSessionFile = `${trimSlash(expandedHost.remoteSessionDir)}/${basenameNoExt(sessionFile)}-${shortSessionId}.jsonl`;
	const repos = await inferRepos(pi, ctx, expandedHost, sessionId);
	const remoteCwd = mapIntoRemoteWorktree(ctx.cwd, repos) ?? mapPath(ctx.cwd, expandedHost);
	return {
		hostName,
		host: expandedHost,
		sessionFile,
		sessionId,
		shortSessionId,
		remoteSessionFile,
		remoteCwd,
		repos,
		tmuxSession: `${host.launch.tmuxPrefix ?? "pi-push"}-${shortSessionId}`,
		dryRun,
	};
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
	await run(pi, "ssh", [plan.host.ssh, `mkdir -p ${q(dirname(plan.remoteSessionFile))}`], "Could not create remote session directory.");
	await run(pi, "scp", [plan.sessionFile, `${plan.host.ssh}:${plan.remoteSessionFile}`], "Could not copy session file.");
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
	await run(pi, "ssh", [ssh, script], `Could not prepare remote worktree: ${repo.remoteWorktree}`);
}

async function launchRemote(pi: ExtensionAPI, plan: PushPlan) {
	const prompt = plan.host.continuationPrompt;
	const piCommand = `cd ${q(plan.remoteCwd)} && pi --session ${q(plan.remoteSessionFile)} ${q(prompt)}`;
	const command = plan.host.launch.command
		? renderTemplate(plan.host.launch.command, { remoteCwd: plan.remoteCwd, sessionFile: plan.remoteSessionFile, prompt, tmuxSession: plan.tmuxSession })
		: `tmux new-session -d -s ${q(plan.tmuxSession)} ${q(piCommand)}`;
	await run(pi, "ssh", [plan.host.ssh, command], "Could not launch remote Pi.");
}

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
