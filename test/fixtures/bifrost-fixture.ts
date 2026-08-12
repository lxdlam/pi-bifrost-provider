import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_PATH = join(ROOT, "test", "fixtures", "aimock.json");

interface FixtureAddress {
	bindHost: string;
	host: string;
	port: number;
	url: string;
}

interface LoggedChild {
	name: string;
	process: ChildProcess;
	lines: string[];
}

function envString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
	return env[name]?.trim() || fallback;
}

function parsePort(value: string | undefined, name: string): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== value.trim()) {
		throw new Error(`${name} must be an integer between 1 and 65535`);
	}
	return port;
}

function connectHost(bindHost: string): string {
	if (bindHost === "0.0.0.0" || bindHost === "::") return "127.0.0.1";
	return bindHost;
}

function hostForUrl(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function freePort(host: string): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, host, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error(`Could not allocate a test port on ${host}`));
				return;
			}
			const port = address.port;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

async function fixtureAddress(
	env: NodeJS.ProcessEnv,
	prefix: "AIMOCK" | "BIFROST",
	excludedPort?: number,
): Promise<FixtureAddress> {
	const bindHost = envString(env, `${prefix}_TEST_BIND_HOST`, "127.0.0.1");
	const host = envString(env, `${prefix}_TEST_HOST`, connectHost(bindHost));
	let port = parsePort(env[`${prefix}_TEST_PORT`], `${prefix}_TEST_PORT`) ?? (await freePort(bindHost));
	while (port === excludedPort) port = await freePort(bindHost);
	return { bindHost, host, port, url: `http://${hostForUrl(host)}:${port}` };
}

function appendOutput(child: LoggedChild, chunk: Buffer, verbose: boolean): void {
	for (const line of chunk.toString("utf8").split(/\r?\n/u).filter(Boolean)) {
		child.lines.push(line);
		if (child.lines.length > 200) child.lines.shift();
		if (verbose) process.stderr.write(`[${child.name}] ${line}\n`);
	}
}

function spawnLogged(
	name: string,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	verbose: boolean,
): LoggedChild {
	const child: LoggedChild = {
		name,
		process: spawn(command, args, {
			cwd: ROOT,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			shell: process.platform === "win32",
			windowsHide: true,
		}),
		lines: [],
	};
	child.process.stdout?.on("data", (chunk: Buffer) => appendOutput(child, chunk, verbose));
	child.process.stderr?.on("data", (chunk: Buffer) => appendOutput(child, chunk, verbose));
	return child;
}

function outputTail(child: LoggedChild): string {
	return child.lines.length ? `\n${child.lines.slice(-30).join("\n")}` : "";
}

async function waitForReady(child: LoggedChild, url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError = "not ready";
	while (Date.now() < deadline) {
		if (child.process.exitCode !== null) {
			throw new Error(`${child.name} exited with code ${child.process.exitCode}${outputTail(child)}`);
		}
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) return;
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`${child.name} did not become ready: ${lastError}${outputTail(child)}`);
}

async function stopChild(child: LoggedChild): Promise<void> {
	const pid = child.process.pid;
	if (!pid || child.process.exitCode !== null) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
	} else {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// The process may have exited between the check and signal.
		}
	}
	await Promise.race([
		new Promise<void>((resolve) => child.process.once("exit", () => resolve())),
		new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
	]);
}

export class BifrostTestFixture {
	readonly url: string;
	readonly aimockUrl: string;
	readonly appDir: string;
	private readonly children: LoggedChild[];
	private stopped = false;

	private constructor(url: string, aimockUrl: string, appDir: string, children: LoggedChild[]) {
		this.url = url;
		this.aimockUrl = aimockUrl;
		this.appDir = appDir;
		this.children = children;
	}

	static async start(env: NodeJS.ProcessEnv = process.env): Promise<BifrostTestFixture> {
		const verbose = env.BIFROST_TEST_VERBOSE === "1";
		const timeoutMs = Number.parseInt(env.BIFROST_TEST_START_TIMEOUT_MS ?? "120000", 10);
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new Error("BIFROST_TEST_START_TIMEOUT_MS must be a positive integer");
		}
		const aimock = await fixtureAddress(env, "AIMOCK");
		const bifrost = await fixtureAddress(env, "BIFROST", aimock.port);
		const appDir = await mkdtemp(join(tmpdir(), "pi-bifrost-provider-"));
		const children: LoggedChild[] = [];
		const fixture = new BifrostTestFixture(bifrost.url, aimock.url, appDir, children);

		try {
			await writeFile(
				join(appDir, "config.json"),
				JSON.stringify(
					{
						$schema: "https://www.getbifrost.ai/schema",
						config_store: { enabled: false },
						logs_store: { enabled: false },
						providers: {
							openai: {
								keys: [
									{
										name: "aimock",
										value: "sk-aimock-test",
										models: ["*"],
										weight: 1,
									},
								],
								network_config: {
									// Bifrost appends /v1 for OpenAI provider requests.
									base_url: aimock.url,
									allow_private_network: true,
								},
							},
						},
					},
					null,
					2,
				),
				"utf8",
			);

			process.stdout.write(`Starting aimock fixture on ${aimock.url}\n`);
			const aimockChild = spawnLogged(
				"aimock",
				"npx",
				[
					"-y",
					"-p",
					envString(env, "AIMOCK_TEST_PACKAGE", "@copilotkit/aimock"),
					"llmock",
					"-h",
					aimock.bindHost,
					"-p",
					String(aimock.port),
					"-f",
					FIXTURE_PATH,
					"--strict",
					"--log-level",
					"warn",
				],
				env,
				verbose,
			);
			children.push(aimockChild);
			await waitForReady(aimockChild, `${aimock.url}/health`, timeoutMs);

			process.stdout.write(`Starting Bifrost fixture on ${bifrost.url}\n`);
			const bifrostChild = spawnLogged(
				"bifrost",
				"npx",
				[
					"-y",
					envString(env, "BIFROST_TEST_PACKAGE", "@maximhq/bifrost"),
					"-app-dir",
					appDir,
					"-host",
					bifrost.bindHost,
					"-port",
					String(bifrost.port),
					"-log-level",
					"warn",
				],
				env,
				verbose,
			);
			children.push(bifrostChild);
			await waitForReady(bifrostChild, `${bifrost.url}/health`, timeoutMs);
			return fixture;
		} catch (error) {
			await fixture.stop();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		for (const child of [...this.children].reverse()) await stopChild(child);
		await rm(this.appDir, { recursive: true, force: true });
	}
}
