import { type ChildProcess, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BifrostTestFixture } from "./fixtures/bifrost-fixture.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const integration = process.argv.includes("--integration");
const fixtureOnly = process.argv.includes("--fixture");
let suite: ChildProcess | undefined;
let fixture: BifrostTestFixture | undefined;
let stopPromise: Promise<void> | undefined;

async function testFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return testFiles(path);
			return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
		}),
	);
	return files.flat().sort();
}

async function runSuite(env: NodeJS.ProcessEnv): Promise<number> {
	const files = await testFiles(join(ROOT, "test"));
	if (files.length === 0) throw new Error("No test files found");
	return new Promise<number>((resolve, reject) => {
		suite = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
			cwd: ROOT,
			env,
			stdio: "inherit",
			windowsHide: true,
		});
		suite.once("error", reject);
		suite.once("exit", (code, signal) => {
			suite = undefined;
			if (signal) reject(new Error(`Test suite terminated by ${signal}`));
			else resolve(code ?? 1);
		});
	});
}

async function waitForSignal(): Promise<void> {
	process.stdout.write(
		["", "Bifrost fixture is ready.", `BIFROST_TEST_URL=${fixture?.url}`, "Press Ctrl+C to stop.", ""].join("\n"),
	);
	await new Promise<void>((resolve) => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
}

function stop(): Promise<void> {
	stopPromise ??= (async () => {
		if (suite?.pid) suite.kill("SIGTERM");
		await fixture?.stop();
	})();
	return stopPromise;
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

try {
	if (integration || fixtureOnly) fixture = await BifrostTestFixture.start(process.env);
	if (fixtureOnly) {
		await waitForSignal();
	} else {
		const code = await runSuite({
			...process.env,
			BIFROST_TEST_MODE: integration ? "integration" : "mock",
			...(fixture ? { BIFROST_TEST_URL: fixture.url } : {}),
		});
		process.exitCode = code;
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
} finally {
	await stop();
}
