import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Run = (command: string, args: string[], cwd: string) => string;

const runCommand: Run = (command, args, cwd) =>
	execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });

export function release(version: string, root = ROOT, run: Run = runCommand): void {
	if (version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
		throw new Error("Usage: npm run release -- x.y.z (without a v prefix or leading zeroes)");
	}
	const tag = `v${version}`;
	const branch = `release/${tag}`;
	const npmCli = process.env.npm_execpath;
	if (!npmCli) throw new Error("Run this script with npm run release -- x.y.z");
	if (run("git", ["status", "--porcelain"], root).trim()) {
		throw new Error("Working tree must be clean before releasing.");
	}
	if (run("git", ["tag", "--list", tag], root).trim()) {
		throw new Error(`Tag ${tag} already exists.`);
	}
	run("git", ["remote", "get-url", "origin"], root);
	run("gh", ["auth", "status"], root);
	const base = run("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], root).trim();
	if (!base) throw new Error("Could not determine the repository's default branch.");

	const packagePath = join(root, "package.json");
	const pkg: { version: string } = JSON.parse(readFileSync(packagePath, "utf8"));
	pkg.version = version;

	run("git", ["switch", "-c", branch], root);
	writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
	run(process.execPath, [npmCli, "install", "--package-lock-only", "--ignore-scripts"], root);

	run("git", ["add", "--", "package.json", "package-lock.json"], root);
	run("git", ["commit", "-m", `chore: release ${tag}`], root);
	run("git", ["tag", tag, "HEAD"], root);
	run("git", ["push", "--set-upstream", "origin", branch], root);
	run("git", ["push", "origin", `refs/tags/${tag}`], root);
	const pr = run(
		"gh",
		[
			"pr",
			"create",
			"--base",
			base,
			"--head",
			branch,
			"--title",
			`chore: release ${tag}`,
			"--body",
			`Bump the package version to ${version} and regenerate package-lock.json with npm.\n\nTag: ${tag}. Merging this PR into ${base} publishes ${version} to npm and creates the GitHub release; nothing is released before then.`,
		],
		root,
	).trim();
	console.log(`Release PR: ${pr}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		release(process.argv.length === 3 ? process.argv[2] : "");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
