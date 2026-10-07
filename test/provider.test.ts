import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import {
	type BifrostConfig,
	type BifrostProviderModel,
	bifrostHeaders,
	buildMetadataIndex,
	configFromEnvironment,
	createBifrostProvider,
	fetchBifrostModels,
	flagFromArgv,
	loadMetadataIndex,
	metadataFor,
	normalizeBifrostUrl,
	normalizeModelKey,
	toProviderModel,
} from "../index.ts";

const TEST_MODE = process.env.BIFROST_TEST_MODE ?? "mock";
const INTEGRATION_URL = process.env.BIFROST_TEST_URL;
if (TEST_MODE !== "mock" && TEST_MODE !== "integration") {
	throw new Error(`Unknown BIFROST_TEST_MODE: ${TEST_MODE}`);
}
if (TEST_MODE === "integration" && !INTEGRATION_URL) {
	throw new Error("BIFROST_TEST_URL is required in integration mode");
}
const IS_INTEGRATION = TEST_MODE === "integration";
const EXPECTED_MODEL_ID = "openai/gpt-4";
const EXPECTED_RESPONSE = "Bifrost provider test passed.";

function mockDiscoveryResponse(): Response {
	return Response.json({
		data: [
			{
				id: EXPECTED_MODEL_ID,
				name: "GPT-4 Mock",
				context_length: 8_192,
				max_output_tokens: 4_096,
				supported_methods: ["chat.completions"],
			},
		],
	});
}

async function activeBackend(): Promise<{
	config: BifrostConfig;
	models: BifrostProviderModel[];
}> {
	if (IS_INTEGRATION) {
		const config = { url: normalizeBifrostUrl(INTEGRATION_URL!) };
		return { config, models: await fetchBifrostModels(config) };
	}
	const config = { url: "https://mock.bifrost.test/openai/v1" };
	return {
		config,
		models: await fetchBifrostModels(config, { fetch: async () => mockDiscoveryResponse() }),
	};
}

test("reads extension flags in both CLI forms", () => {
	assert.equal(flagFromArgv("bifrost-url", ["--bifrost-url", "https://one.example"]), "https://one.example");
	assert.equal(flagFromArgv("bifrost-url", ["--bifrost-url=https://two.example"]), "https://two.example");
	assert.equal(flagFromArgv("bifrost-url", ["--bifrost-url"]), undefined);
});

test("normalizes Bifrost instance and API URLs", () => {
	assert.equal(normalizeBifrostUrl("http://localhost:8080"), "http://localhost:8080/openai/v1");
	assert.equal(normalizeBifrostUrl("https://example.com/gateway/"), "https://example.com/gateway/openai/v1");
	assert.equal(normalizeBifrostUrl("https://example.com/openai"), "https://example.com/openai/v1");
	assert.equal(normalizeBifrostUrl("https://example.com/openai/v1/"), "https://example.com/openai/v1");
	assert.equal(normalizeBifrostUrl("https://example.com/v1/chat/completions"), "https://example.com/v1");
	assert.throws(() => normalizeBifrostUrl(""), /required/u);
	assert.throws(() => normalizeBifrostUrl("file:///tmp/bifrost"), /http/u);
});

test("requires URL and trims optional environment parameters", () => {
	assert.throws(() => configFromEnvironment({}), /BIFROST_URL .* required/u);
	assert.deepEqual(
		configFromEnvironment({
			BIFROST_URL: " http://localhost:8080 ",
			BIFROST_API_KEY: " api-secret ",
			BIFROST_VIRTUAL_KEY: " sk-bf-test ",
		}),
		{
			url: "http://localhost:8080/openai/v1",
			apiKey: "api-secret",
			virtualKey: "sk-bf-test",
		},
	);
	assert.deepEqual(
		configFromEnvironment(
			{ BIFROST_URL: "https://env.example", BIFROST_API_KEY: "env-key" },
			{ url: "https://flag.example/v1", apiKey: "flag-key", virtualKey: "flag-vk" },
		),
		{
			url: "https://flag.example/v1",
			apiKey: "flag-key",
			virtualKey: "flag-vk",
		},
	);
});

test("builds independent API authentication and governance headers", () => {
	assert.deepEqual(bifrostHeaders({ url: "https://example.com/openai/v1" }), {
		Accept: "application/json",
		Authorization: null,
	});
	assert.deepEqual(
		bifrostHeaders({
			url: "https://example.com/openai/v1",
			apiKey: "api-secret",
			virtualKey: "sk-bf-test",
		}),
		{
			Accept: "application/json",
			Authorization: "Bearer api-secret",
			"x-bf-vk": "sk-bf-test",
		},
	);
	assert.deepEqual(
		bifrostHeaders(
			{ url: "https://example.com/openai/v1", apiKey: "configured", virtualKey: "configured-vk" },
			{ authorization: "Bearer override", "X-BF-VK": "override-vk" },
		),
		{
			Accept: "application/json",
			authorization: "Bearer override",
			"X-BF-VK": "override-vk",
		},
	);
});

test("maps Bifrost model metadata into a pi model", () => {
	const model = toProviderModel({
		id: "anthropic/claude-sonnet-4-6",
		normalized_name: "Claude Sonnet 4.6",
		context_length: 200_000,
		max_output_tokens: 32_000,
		architecture: { input_modalities: ["text", "image"] },
		pricing: {
			prompt: "0.000003",
			completion: "0.000015",
			input_cache_read: "0.0000003",
			input_cache_write: "0.00000375",
		},
		supported_parameters: ["tools", "reasoning_effort"],
		reasoning: { supported_efforts: ["low", "medium", "high"] },
		supported_methods: ["chat.completions"],
	});

	assert.ok(model);
	assert.equal(model.id, "anthropic/claude-sonnet-4-6");
	assert.equal(model.name, "Claude Sonnet 4.6");
	assert.equal(model.contextWindow, 200_000);
	assert.equal(model.maxTokens, 32_000);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.deepEqual(model.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.thinkingLevelMap, {
		off: "off",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	});
});

test("omits models that advertise only non-chat methods", () => {
	assert.equal(toProviderModel({ id: "openai/text-embedding-3-small", supported_methods: ["embeddings"] }), undefined);
});

test("discovers models from the active test backend", async () => {
	const { models } = await activeBackend();
	const model = models.find((candidate) => candidate.id === EXPECTED_MODEL_ID);
	assert.ok(model, `${EXPECTED_MODEL_ID} was not returned by ${TEST_MODE} discovery`);
	assert.ok(model.contextWindow > 0);
	assert.ok(model.maxTokens > 0);
});

test("maps discovery responses, forwards headers, and de-duplicates IDs", async () => {
	let requestedUrl: string | undefined;
	let requestedHeaders: Headers | undefined;
	const mockFetch: typeof fetch = async (input, init) => {
		requestedUrl = String(input);
		requestedHeaders = new Headers(init?.headers);
		return Response.json({
			data: [
				{ id: "openai/gpt-test", context_length: 64_000, max_output_tokens: 4_096 },
				{ id: "openai/gpt-test", context_length: 128_000, max_output_tokens: 8_192 },
				{ id: "openai/embed-test", supported_methods: ["embeddings"] },
			],
		});
	};

	const models = await fetchBifrostModels(
		{
			url: "https://bifrost.example/openai/v1",
			apiKey: "api-secret",
			virtualKey: "sk-bf-test",
		},
		{ fetch: mockFetch },
	);

	assert.equal(requestedUrl, "https://bifrost.example/openai/v1/models");
	assert.equal(requestedHeaders?.get("authorization"), "Bearer api-secret");
	assert.equal(requestedHeaders?.get("x-bf-vk"), "sk-bf-test");
	assert.equal(models.length, 1);
	assert.equal(models[0]?.contextWindow, 128_000);
});

test("does not send an Authorization header for a keyless model-list request", async () => {
	let requestedHeaders: Headers | undefined;
	const mockFetch: typeof fetch = async (_input, init) => {
		requestedHeaders = new Headers(init?.headers);
		return Response.json({ data: [{ id: "ollama/qwen3" }] });
	};

	await fetchBifrostModels({ url: "http://localhost:8080/openai/v1" }, { fetch: mockFetch, metadata: null });
	assert.equal(requestedHeaders?.has("authorization"), false);
});

test("configures and persists the native provider through /login", async () => {
	const requests: Array<{ url: string; headers: Headers }> = [];
	const loginUrl = IS_INTEGRATION ? INTEGRATION_URL! : "https://login.example";
	const virtualKey = IS_INTEGRATION ? "" : "sk-bf-login";
	const mockFetch: typeof fetch = async (input, init) => {
		requests.push({ url: String(input), headers: new Headers(init?.headers) });
		return mockDiscoveryResponse();
	};
	const provider = createBifrostProvider({ fetch: IS_INTEGRATION ? fetch : mockFetch });
	assert.equal(provider.name, "Bifrost AI Gateway");
	const login = provider.auth.apiKey?.login;
	assert.ok(login);
	const answers = [loginUrl, "", virtualKey];
	const notifications: string[] = [];
	const infoLinks: string[] = [];
	const credential = await login({
		signal: new AbortController().signal,
		prompt: async () => answers.shift() ?? "",
		notify: (event) => {
			notifications.push(event.type);
			if (event.type === "info") infoLinks.push(...(event.links?.map((link) => link.url) ?? []));
		},
	});
	const normalizedLoginUrl = normalizeBifrostUrl(loginUrl);

	assert.deepEqual(credential, {
		type: "api_key",
		key: "pi-bifrost-keyless",
		env: {
			BIFROST_URL: normalizedLoginUrl,
			BIFROST_VIRTUAL_KEY: virtualKey,
		},
	});
	if (!IS_INTEGRATION) {
		assert.equal(requests[0]?.url, "https://login.example/openai/v1/models");
		assert.equal(requests[0]?.headers.get("authorization"), null);
		assert.equal(requests[0]?.headers.get("x-bf-vk"), "sk-bf-login");
	}
	assert.deepEqual(notifications, ["info", "progress"]);
	assert.deepEqual(infoLinks, ["https://docs.getbifrost.ai/overview", "https://www.getmaxim.ai/bifrost"]);
	assert.ok(provider.getModels().some((model) => model.id === EXPECTED_MODEL_ID));

	let persistedModels: readonly unknown[] | undefined;
	await provider.refreshModels?.({
		credential,
		allowNetwork: false,
		signal: new AbortController().signal,
		publish: async (publication) => {
			persistedModels = publication.persist?.models;
			publication.update?.();
			return true;
		},
	});
	assert.ok(persistedModels?.length);

	const resolved = await provider.auth.apiKey?.resolve({
		credential,
		signal: new AbortController().signal,
		ctx: { env: async () => undefined, fileExists: async () => false },
	});
	assert.equal(resolved?.auth.baseUrl, normalizedLoginUrl);
	assert.equal(resolved?.auth.headers?.Authorization, null);
	assert.equal(resolved?.auth.headers?.["x-bf-vk"], virtualKey || undefined);
});

test("streams chat completions through the active test backend", async () => {
	const { config, models: discovered } = await activeBackend();
	const provider = createBifrostProvider({ config, models: discovered });
	const models = createModels();
	models.setProvider(provider);
	const model = models.getModel("bifrost", EXPECTED_MODEL_ID);
	assert.ok(model);

	let requestedUrl: string | undefined;
	const mockFetch: typeof fetch = async (input) => {
		requestedUrl = String(input);
		const body = [
			`data: ${JSON.stringify({
				id: "chatcmpl-test",
				model: EXPECTED_MODEL_ID,
				choices: [{ index: 0, delta: { role: "assistant", content: EXPECTED_RESPONSE }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-test",
				model: EXPECTED_MODEL_ID,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
			})}`,
			"data: [DONE]",
			"",
		].join("\n\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const streamOptions: SimpleStreamOptions = { signal: AbortSignal.timeout(15_000) };
	if (!IS_INTEGRATION) streamOptions.fetch = mockFetch;
	const response = await models.completeSimple(
		model,
		{
			messages: [{ role: "user", content: "pi bifrost provider test", timestamp: Date.now() }],
		},
		streamOptions,
	);
	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	assert.equal(text, EXPECTED_RESPONSE);
	assert.equal(response.stopReason, "stop");
	if (!IS_INTEGRATION) assert.equal(requestedUrl, "https://mock.bifrost.test/openai/v1/chat/completions");
});

test("keeps an unconfigured native provider available for /login", async () => {
	const provider = createBifrostProvider();
	assert.ok(provider.auth.apiKey?.login);
	assert.deepEqual(provider.getModels(), []);
	assert.equal(
		await provider.auth.apiKey?.resolve({
			signal: new AbortController().signal,
			ctx: { env: async () => undefined, fileExists: async () => false },
		}),
		undefined,
	);
});

test("surfaces Bifrost model discovery errors", async () => {
	const mockFetch: typeof fetch = async () =>
		Response.json({ error: { message: "virtual key is invalid" } }, { status: 403 });
	await assert.rejects(
		fetchBifrostModels({ url: "https://example.com/openai/v1" }, { fetch: mockFetch }),
		/Bifrost model discovery failed \(403\): virtual key is invalid/u,
	);
});

/** Shape-compatible subset of models.dev `api.json`. */
const CATALOG = {
	anthropic: { models: { "claude-opus-5-5": { limit: { context: 1_000_000, output: 128_000 } } } },
	// A gateway that clips the window must not win over the two providers that agree.
	openrouter: { models: { "claude-opus-5-5": { limit: { context: 200_000, output: 64_000 } } } },
	deepseek: { models: { "deepseek-v4.1-flash": { limit: { context: 1_000_000 } } } },
};

const DISCOVERY_URL = "https://bifrost.example/openai/v1";
const OPUS_MODEL = "CommandCode/claude-opus-5-5";

async function tempCachePath(): Promise<string> {
	return join(await mkdtemp(join(tmpdir(), "pi-bifrost-metadata-")), "models-dev.json");
}

function discoveryFetch(entries: unknown[]): typeof fetch {
	return async () => Response.json({ data: entries });
}

const offlineFetch: typeof fetch = async () => {
	throw new Error("offline");
};

test("normalizes catalog keys across Bifrost prefixes, tags, and dates", () => {
	assert.equal(normalizeModelKey(" CommandCode/Claude-Opus-5-5 "), "commandcode/claude-opus-5-5");
	assert.equal(normalizeModelKey("poolside/laguna-s-2.1:free"), "poolside/laguna-s-2.1");
	assert.equal(normalizeModelKey("claude-opus-4-5-20251101"), "claude-opus-4-5");
});

test("takes the most-reported window, not whichever provider comes first", () => {
	const majority = buildMetadataIndex({
		abacus: { models: { "gpt-5.4": { limit: { context: 400_000, output: 128_000 } } } },
		azure: { models: { "gpt-5.4": { limit: { context: 1_050_000, output: 128_000 } } } },
		"302ai": { models: { "gpt-5.4": { limit: { context: 1_050_000, output: 64_000 } } } },
		freemodel: { models: { "gpt-5.4": { limit: { context: 1_050_000, output: 32_000 } } } },
		// 2-2 on the window: the tie must resolve to the larger one.
		other: { models: { "tie-model": { limit: { context: 1_048_576 } } } },
		third: { models: { "tie-model": { limit: { context: 262_144 } } } },
		// One provider spells the id with a vendor prefix and claims a 1M output cap; the twelve
		// behind the bare spelling say 512k, and both spellings must vote in one bucket.
		minimax: { models: { "minimax-m3": { limit: { context: 1_048_576, output: 512_000 } } } },
		"minimax-cn": { models: { "minimax-m3": { limit: { context: 1_048_576, output: 512_000 } } } },
		"outlier-host": { models: { "minimaxai/minimax-m3": { limit: { context: 1_048_576, output: 1_048_576 } } } },
	});
	assert.deepEqual(metadataFor(majority, "gpt-5.4"), { contextWindow: 1_050_000, maxTokens: 128_000 });
	assert.deepEqual(metadataFor(majority, "tie-model"), { contextWindow: 1_048_576, maxTokens: undefined });
	assert.deepEqual(metadataFor(majority, "minimax-m3"), { contextWindow: 1_048_576, maxTokens: 512_000 });
	assert.deepEqual(metadataFor(majority, "CommandCode/MiniMaxAI/MiniMax-M3"), {
		contextWindow: 1_048_576,
		maxTokens: 512_000,
	});
});

test("resolves limits through gateway and vendor path segments", () => {
	const index = buildMetadataIndex(CATALOG);
	assert.deepEqual(metadataFor(index, OPUS_MODEL), { contextWindow: 1_000_000, maxTokens: 128_000 });
	assert.deepEqual(metadataFor(index, "deepseek/deepseek-v4.1-flash"), {
		contextWindow: 1_000_000,
		maxTokens: undefined,
	});
	assert.equal(metadataFor(index, "CommandCode/unknown-model"), undefined);
	assert.equal(metadataFor(undefined, OPUS_MODEL), undefined);
	assert.equal(buildMetadataIndex(undefined).size, 0);
	assert.equal(buildMetadataIndex({ broken: { models: "not-an-object" } }).size, 0);
});

test("prefers Bifrost limits and fills only the ones it omits", () => {
	const metadata = metadataFor(buildMetadataIndex(CATALOG), OPUS_MODEL);
	const declared = toProviderModel({ id: OPUS_MODEL, context_length: 200_000, max_output_tokens: 8_192 }, metadata);
	assert.equal(declared?.contextWindow, 200_000);
	assert.equal(declared?.maxTokens, 8_192);

	const partial = toProviderModel({ id: OPUS_MODEL, context_length: 300_000 }, metadata);
	assert.equal(partial?.contextWindow, 300_000);
	assert.equal(partial?.maxTokens, 128_000);

	const filled = toProviderModel({ id: OPUS_MODEL }, metadata);
	assert.equal(filled?.contextWindow, 1_000_000);
	assert.equal(filled?.maxTokens, 128_000);

	const unfilled = toProviderModel({ id: OPUS_MODEL });
	assert.equal(unfilled?.contextWindow, 128_000);
	assert.equal(unfilled?.maxTokens, 8_192);
});

test("caches the catalog on disk and reuses it without network access", async () => {
	const cachePath = await tempCachePath();
	let calls = 0;
	const fetchImpl: typeof fetch = async () => {
		calls += 1;
		return Response.json(CATALOG);
	};
	const first = await loadMetadataIndex({ fetch: fetchImpl, cachePath });
	assert.equal(calls, 1);
	assert.deepEqual(metadataFor(first, OPUS_MODEL), { contextWindow: 1_000_000, maxTokens: 128_000 });
	assert.match(await readFile(cachePath, "utf8"), /claude-opus-5-5/u);

	const cached = await loadMetadataIndex({ fetch: offlineFetch, cachePath });
	assert.deepEqual(metadataFor(cached, OPUS_MODEL), { contextWindow: 1_000_000, maxTokens: 128_000 });
});

test("falls back to a stale cache and tolerates a missing one", async () => {
	const cachePath = await tempCachePath();
	await loadMetadataIndex({ fetch: async () => Response.json(CATALOG), cachePath });
	const stale = await loadMetadataIndex({
		fetch: offlineFetch,
		cachePath,
		now: Date.now() + 7 * 24 * 60 * 60 * 1_000,
	});
	assert.deepEqual(metadataFor(stale, "claude-opus-5-5"), { contextWindow: 1_000_000, maxTokens: 128_000 });
	assert.equal(await loadMetadataIndex({ fetch: offlineFetch, cachePath: await tempCachePath() }), undefined);
});

test("fills discovery results from the fallback catalog", async () => {
	const options = { fetch: discoveryFetch([{ id: OPUS_MODEL }]) };
	const filled = await fetchBifrostModels(
		{ url: DISCOVERY_URL },
		{ ...options, metadata: buildMetadataIndex(CATALOG) },
	);
	assert.equal(filled[0]?.contextWindow, 1_000_000);
	assert.equal(filled[0]?.maxTokens, 128_000);

	const unfilled = await fetchBifrostModels({ url: DISCOVERY_URL }, { ...options, metadata: null });
	assert.equal(unfilled[0]?.contextWindow, 128_000);
	assert.equal(unfilled[0]?.maxTokens, 8_192);
});

test("reports models left on the default limits through the notice sink", async () => {
	const notices: Array<{ message: string; type?: string }> = [];
	const notify = (message: string, type?: "info" | "warning" | "error") => notices.push({ message, type });
	const options = { fetch: discoveryFetch([{ id: "CommandCode/unknown-model" }]), metadata: null, notify };

	await fetchBifrostModels({ url: DISCOVERY_URL }, options);
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.type, "warning");
	assert.match(notices[0]?.message ?? "", /CommandCode\/unknown-model/u);

	// Announced once per id per process, so refresh loops stay quiet.
	await fetchBifrostModels({ url: DISCOVERY_URL }, options);
	assert.equal(notices.length, 1);

	// A provider used without a sink (SDK, headless) stays silent.
	assert.doesNotThrow(() => fetchBifrostModels({ url: DISCOVERY_URL }, { ...options, notify: undefined }));
});
