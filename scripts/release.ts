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
	if (run("git", ["status", "--porcelain"], root).trim()) {
		throw new Error("Working tree must be clean before releasing.");
	}
	if (run("git", ["tag", "--list", tag], root).trim()) {
		throw new Error(`Tag ${tag} already exists.`);
	}
	run("git", ["remote", "get-url", "origin"], root);
	run("gh", ["auth", "status"], root);

	const packagePath = join(root, "package.json");
	const lockPath = join(root, "package-lock.json");
	const pkg: { version: string } = JSON.parse(readFileSync(packagePath, "utf8"));
	const lock: { version: string; packages: Record<string, { version: string }> } = JSON.parse(
		readFileSync(lockPath, "utf8"),
	);
	if (!lock.packages[""]) throw new Error("package-lock.json is missing its root package.");
	pkg.version = version;
	lock.version = version;
	lock.packages[""].version = version;

	// Tag the existing commit, not the uncommitted version bump.
	run("git", ["tag", tag, "HEAD"], root);
	writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
	writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
	run("git", ["push", "origin", `refs/tags/${tag}`], root);
	run("gh", ["release", "create", tag, "--verify-tag", "--generate-notes"], root);
	console.log(`Released ${tag}. The version bump is uncommitted; review and commit it separately.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		release(process.argv.length === 3 ? process.argv[2] : "");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
