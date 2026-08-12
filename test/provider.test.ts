import assert from "node:assert/strict";
import test from "node:test";
import {
	bifrostHeaders,
	configFromEnvironment,
	createBifrostProvider,
	fetchBifrostModels,
	flagFromArgv,
	normalizeBifrostUrl,
	toProviderModel,
} from "../index.ts";

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

test("discovers models with both auth headers and de-duplicates IDs", async () => {
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

	await fetchBifrostModels({ url: "http://localhost:8080/openai/v1" }, { fetch: mockFetch });
	assert.equal(requestedHeaders?.has("authorization"), false);
});

test("configures and persists the native provider through /login", async () => {
	const requests: Array<{ url: string; headers: Headers }> = [];
	const mockFetch: typeof fetch = async (input, init) => {
		requests.push({ url: String(input), headers: new Headers(init?.headers) });
		return Response.json({ data: [{ id: "anthropic/claude-login-test", context_length: 200_000 }] });
	};
	const provider = createBifrostProvider({ fetch: mockFetch });
	const login = provider.auth.apiKey?.login;
	assert.ok(login);
	const answers = ["https://login.example", "", "sk-bf-login"];
	const notifications: string[] = [];
	const credential = await login({
		signal: new AbortController().signal,
		prompt: async () => answers.shift() ?? "",
		notify: (event) => notifications.push(event.type),
	});

	assert.deepEqual(credential, {
		type: "api_key",
		key: "pi-bifrost-keyless",
		env: {
			BIFROST_URL: "https://login.example/openai/v1",
			BIFROST_VIRTUAL_KEY: "sk-bf-login",
		},
	});
	assert.equal(requests[0]?.url, "https://login.example/openai/v1/models");
	assert.equal(requests[0]?.headers.get("authorization"), null);
	assert.equal(requests[0]?.headers.get("x-bf-vk"), "sk-bf-login");
	assert.deepEqual(notifications, ["info", "progress"]);
	assert.equal(provider.getModels()[0]?.id, "anthropic/claude-login-test");

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
	assert.equal(persistedModels?.length, 1);

	const resolved = await provider.auth.apiKey?.resolve({
		credential,
		signal: new AbortController().signal,
		ctx: { env: async () => undefined, fileExists: async () => false },
	});
	assert.equal(resolved?.auth.baseUrl, "https://login.example/openai/v1");
	assert.equal(resolved?.auth.headers?.Authorization, null);
	assert.equal(resolved?.auth.headers?.["x-bf-vk"], "sk-bf-login");
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
