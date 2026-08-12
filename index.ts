import {
	type ApiKeyCredential,
	createProvider,
	type Model,
	openAICompletionsApi,
	type Provider,
	type ProviderHeaders,
	type RefreshModelsContext,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "bifrost";
const PLACEHOLDER_API_KEY = "pi-bifrost-keyless";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

export interface BifrostConfig {
	/** Bifrost instance URL or an OpenAI-compatible Bifrost base URL. */
	url: string;
	/** Bifrost/provider API key sent as a Bearer token. */
	apiKey?: string;
	/** Bifrost governance virtual key sent using x-bf-vk. */
	virtualKey?: string;
}

export interface BifrostModelResponse {
	data?: BifrostModel[];
}

export interface BifrostModel {
	id?: string;
	name?: string;
	normalized_name?: string;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	pricing?: {
		prompt?: string | number;
		completion?: string | number;
		input_cache_read?: string | number;
		input_cache_write?: string | number;
	};
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number;
	};
	per_request_limits?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
	supported_parameters?: string[];
	supported_methods?: string[];
	reasoning?: {
		mandatory?: boolean;
		default_enabled?: boolean;
		supported_efforts?: string[];
		default_effort?: string;
	};
}

export interface BifrostProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: {
		supportsDeveloperRole: true;
		supportsReasoningEffort: boolean;
		supportsUsageInStreaming: true;
		supportsStrictMode: true;
		maxTokensField: "max_completion_tokens";
	};
}

type Fetch = typeof globalThis.fetch;

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** Extension CLI values are applied after factories run, so startup-time model discovery reads argv directly. */
export function flagFromArgv(name: string, argv: readonly string[] = process.argv.slice(2)): string | undefined {
	const flag = `--${name}`;
	let result: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument.startsWith(`${flag}=`)) {
			result = nonEmpty(argument.slice(flag.length + 1));
		} else if (argument === flag) {
			const next = argv[index + 1];
			if (next && !next.startsWith("--")) result = nonEmpty(next);
		}
	}
	return result;
}

/**
 * Convert an instance URL to the base URL expected by pi's OpenAI Chat
 * Completions adapter. A URL that already ends in /v1 is preserved; otherwise
 * the Bifrost OpenAI integration mount is appended.
 */
export function normalizeBifrostUrl(value: string): string {
	const input = value.trim();
	if (!input) throw new Error("BIFROST_URL is required");

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error(`Invalid BIFROST_URL: ${value}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("BIFROST_URL must use http:// or https://");
	}
	if (parsed.search || parsed.hash) {
		throw new Error("BIFROST_URL must not contain a query string or fragment");
	}

	let path = parsed.pathname.replace(/\/+$/u, "");
	path = path.replace(/\/(?:chat\/completions|models)$/u, "");
	if (!/\/v1$/u.test(path)) {
		path = /\/openai$/u.test(path) ? `${path}/v1` : `${path}/openai/v1`;
	}
	parsed.pathname = path;
	return parsed.toString().replace(/\/$/u, "");
}

export function optionalConfigFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	overrides: Partial<BifrostConfig> = {},
): BifrostConfig | undefined {
	const rawUrl = nonEmpty(overrides.url) ?? nonEmpty(env.BIFROST_URL);
	if (!rawUrl) return undefined;
	return {
		url: normalizeBifrostUrl(rawUrl),
		apiKey: nonEmpty(overrides.apiKey) ?? nonEmpty(env.BIFROST_API_KEY),
		virtualKey: nonEmpty(overrides.virtualKey) ?? nonEmpty(env.BIFROST_VIRTUAL_KEY),
	};
}

export function configFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	overrides: Partial<BifrostConfig> = {},
): BifrostConfig {
	const config = optionalConfigFromEnvironment(env, overrides);
	if (!config) {
		throw new Error(
			"pi-bifrost-provider: BIFROST_URL or --bifrost-url is required (for example, http://localhost:8080)",
		);
	}
	return config;
}

function setHeader(headers: ProviderHeaders, name: string, value: string | null): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
	}
	headers[name] = value;
}

/** Build request headers while allowing explicit per-request headers to win. */
export function bifrostHeaders(config: BifrostConfig, overrides?: ProviderHeaders): ProviderHeaders {
	const headers: ProviderHeaders = { Accept: "application/json" };
	setHeader(headers, "Authorization", config.apiKey ? `Bearer ${config.apiKey}` : null);
	if (config.virtualKey) setHeader(headers, "x-bf-vk", config.virtualKey);
	for (const [name, value] of Object.entries(overrides ?? {})) setHeader(headers, name, value);
	return headers;
}

function positiveInteger(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	}
	return undefined;
}

/** Bifrost/OpenRouter pricing is normally expressed in dollars per token. */
function pricePerMillion(value: string | number | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const parsed = typeof value === "number" ? value : Number.parseFloat(value);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return parsed <= 0.01 ? parsed * 1_000_000 : parsed;
}

function isChatModel(model: BifrostModel): boolean {
	const methods = model.supported_methods?.map((method) => method.toLowerCase()) ?? [];
	if (methods.length === 0) return true;
	return methods.some((method) => /chat|message|generate|completion/u.test(method));
}

function thinkingLevelMap(model: BifrostModel): ThinkingLevelMap | undefined {
	const supported = model.reasoning?.supported_efforts?.map((effort) => effort.toLowerCase());
	if (!supported?.length) return undefined;
	const has = (level: string) => supported.includes(level);
	return {
		off: model.reasoning?.mandatory ? null : "off",
		minimal: has("minimal") ? "minimal" : null,
		low: has("low") ? "low" : null,
		medium: has("medium") ? "medium" : null,
		high: has("high") ? "high" : null,
		xhigh: has("xhigh") ? "xhigh" : null,
		max: has("max") ? "max" : null,
	};
}

export function toProviderModel(model: BifrostModel): BifrostProviderModel | undefined {
	const id = nonEmpty(model.id);
	if (!id || !isChatModel(model)) return undefined;

	const contextWindow =
		positiveInteger(
			model.context_length,
			model.top_provider?.context_length,
			model.max_input_tokens && model.max_output_tokens
				? model.max_input_tokens + model.max_output_tokens
				: undefined,
			model.per_request_limits?.prompt_tokens,
		) ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = Math.min(
		contextWindow,
		positiveInteger(
			model.max_output_tokens,
			model.top_provider?.max_completion_tokens,
			model.per_request_limits?.completion_tokens,
		) ?? DEFAULT_MAX_TOKENS,
	);
	const parameters = model.supported_parameters?.map((parameter) => parameter.toLowerCase()) ?? [];
	const reasoning = model.reasoning !== undefined || parameters.some((parameter) => parameter.includes("reasoning"));
	const inputModalities = model.architecture?.input_modalities?.map((modality) => modality.toLowerCase()) ?? [];
	const inputPrice = pricePerMillion(model.pricing?.prompt) ?? 0;
	const outputPrice = pricePerMillion(model.pricing?.completion) ?? 0;

	return {
		id,
		name: nonEmpty(model.normalized_name) ?? nonEmpty(model.name) ?? id,
		reasoning,
		thinkingLevelMap: reasoning ? thinkingLevelMap(model) : undefined,
		input: inputModalities.some((modality) => modality.includes("image")) ? ["text", "image"] : ["text"],
		cost: {
			input: inputPrice,
			output: outputPrice,
			cacheRead: pricePerMillion(model.pricing?.input_cache_read) ?? inputPrice,
			cacheWrite: pricePerMillion(model.pricing?.input_cache_write) ?? inputPrice,
		},
		contextWindow,
		maxTokens,
		compat: {
			supportsDeveloperRole: true,
			supportsReasoningEffort: reasoning,
			supportsUsageInStreaming: true,
			supportsStrictMode: true,
			maxTokensField: "max_completion_tokens",
		},
	};
}

function errorMessage(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const candidate = body as { message?: unknown; error?: { message?: unknown } | string };
	if (typeof candidate.error === "string") return candidate.error;
	if (typeof candidate.error?.message === "string") return candidate.error.message;
	if (typeof candidate.message === "string") return candidate.message;
	return undefined;
}

export async function fetchBifrostModels(
	config: BifrostConfig,
	options: { fetch?: Fetch; signal?: AbortSignal } = {},
): Promise<BifrostProviderModel[]> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const requestHeaders = Object.fromEntries(
		Object.entries(bifrostHeaders(config)).filter((entry): entry is [string, string] => entry[1] !== null),
	);
	const response = await fetchImpl(`${config.url}/models`, {
		headers: requestHeaders,
		signal: options.signal,
	});

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	if (!response.ok) {
		const detail = errorMessage(body);
		throw new Error(`Bifrost model discovery failed (${response.status})${detail ? `: ${detail}` : ""}`);
	}
	const data = (body as BifrostModelResponse | undefined)?.data;
	if (!Array.isArray(data)) throw new Error("Bifrost model discovery returned an invalid response (expected data[])");

	const models = data
		.map(toProviderModel)
		.filter((model): model is BifrostProviderModel => model !== undefined);
	const uniqueModels = [...new Map(models.map((model) => [model.id, model])).values()];
	if (uniqueModels.length === 0) {
		throw new Error("Bifrost did not return any chat-completion models");
	}
	return uniqueModels;
}

type BifrostRuntimeModel = Model<"openai-completions">;

function runtimeModels(models: readonly BifrostProviderModel[], baseUrl: string): BifrostRuntimeModel[] {
	return models.map((model) => ({
		...model,
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl,
	}));
}

function credentialConfig(
	credential: ApiKeyCredential | undefined,
	fallback: BifrostConfig | undefined,
): BifrostConfig | undefined {
	const credentialUrl = nonEmpty(credential?.env?.BIFROST_URL);
	const url = credentialUrl ?? fallback?.url;
	if (!url) return undefined;

	const ownsConfig = credentialUrl !== undefined;
	const key = nonEmpty(credential?.key);
	const apiKey = key && key !== PLACEHOLDER_API_KEY ? key : ownsConfig ? undefined : fallback?.apiKey;
	const virtualKey = ownsConfig
		? nonEmpty(credential?.env?.BIFROST_VIRTUAL_KEY)
		: nonEmpty(credential?.env?.BIFROST_VIRTUAL_KEY) ?? fallback?.virtualKey;
	return { url: normalizeBifrostUrl(url), apiKey, virtualKey };
}

function configCredential(config: BifrostConfig): ApiKeyCredential {
	return {
		type: "api_key",
		key: config.apiKey ?? PLACEHOLDER_API_KEY,
		env: {
			BIFROST_URL: config.url,
			// Preserve an intentionally empty value instead of falling back to an
			// ambient virtual key after /login.
			BIFROST_VIRTUAL_KEY: config.virtualKey ?? "",
		},
	};
}

export interface CreateBifrostProviderOptions {
	config?: BifrostConfig;
	models?: readonly BifrostProviderModel[];
	fetch?: Fetch;
}

/** Create the native provider used by Pi, including its /login setup flow. */
export function createBifrostProvider(options: CreateBifrostProviderOptions = {}): Provider<"openai-completions"> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	let ambientConfig = options.config;
	const catalog = runtimeModels(options.models ?? [], ambientConfig?.url ?? "http://localhost/openai/v1");
	let pendingModels = catalog.length > 0 ? [...catalog] : undefined;

	const replaceCatalog = (models: readonly BifrostRuntimeModel[]): void => {
		catalog.splice(0, catalog.length, ...models);
	};

	const refreshModels = async (context: RefreshModelsContext): Promise<void> => {
		// /login fetches before returning the credential. Its following offline
		// refresh lands here, where the fetched catalog can be persisted safely.
		if (pendingModels) {
			const models = pendingModels;
			if (
				await context.publish({
					persist: { models, checkedAt: Date.now() },
					update: () => replaceCatalog(models),
				})
			) {
				pendingModels = undefined;
			}
			return;
		}

		if (context.stored) {
			const restored = context.stored.models.filter(
				(model): model is BifrostRuntimeModel =>
					model.provider === PROVIDER_ID && model.api === "openai-completions",
			);
			if (!(await context.publish({ update: () => replaceCatalog(restored) }))) return;
		}
		if (!context.allowNetwork || context.signal.aborted) return;

		const config = credentialConfig(
			context.credential?.type === "api_key" ? context.credential : undefined,
			ambientConfig,
		);
		if (!config) return;
		const discovered = runtimeModels(
			await fetchBifrostModels(config, { fetch: fetchImpl, signal: context.signal }),
			config.url,
		);
		await context.publish({
			persist: { models: discovered, checkedAt: Date.now() },
			update: () => replaceCatalog(discovered),
		});
	};

	const base = createProvider({
		id: PROVIDER_ID,
		name: "Bifrost",
		baseUrl: ambientConfig?.url,
		auth: {
			apiKey: {
				name: "Bifrost connection",
				async login(interaction) {
					interaction.notify({
						type: "info",
						message: "Configure the Bifrost gateway. API and virtual keys are optional.",
						links: [{ url: "https://docs.getbifrost.ai/overview", label: "Bifrost documentation" }],
					});
					const url = normalizeBifrostUrl(
						await interaction.prompt({
							type: "text",
							message: "Bifrost URL (required)",
							placeholder: ambientConfig?.url ?? "http://localhost:8080",
						}),
					);
					const apiKey = nonEmpty(
						await interaction.prompt({
							type: "secret",
							message: "API key (optional; press Enter to skip)",
						}),
					);
					const virtualKey = nonEmpty(
						await interaction.prompt({
							type: "secret",
							message: "Virtual key (optional; press Enter to skip)",
						}),
					);
					const config = { url, apiKey, virtualKey };
					interaction.notify({ type: "progress", message: "Discovering Bifrost models..." });
					const discovered = runtimeModels(
						await fetchBifrostModels(config, { fetch: fetchImpl, signal: interaction.signal }),
						url,
					);
					ambientConfig = config;
					pendingModels = discovered;
					replaceCatalog(discovered);
					return configCredential(config);
				},
				async resolve({ ctx, credential }) {
					const envConfig = optionalConfigFromEnvironment({
						BIFROST_URL: await ctx.env("BIFROST_URL"),
						BIFROST_API_KEY: await ctx.env("BIFROST_API_KEY"),
						BIFROST_VIRTUAL_KEY: await ctx.env("BIFROST_VIRTUAL_KEY"),
					});
					const config = credentialConfig(credential, ambientConfig ?? envConfig);
					if (!config) return undefined;
					return {
						auth: {
							apiKey: config.apiKey ?? PLACEHOLDER_API_KEY,
							baseUrl: config.url,
							headers: bifrostHeaders(config),
						},
						env: {
							BIFROST_URL: config.url,
							BIFROST_VIRTUAL_KEY: config.virtualKey ?? "",
						},
						source: credential ? "stored Bifrost connection" : "BIFROST_URL",
					};
				},
			},
		},
		models: catalog,
		api: openAICompletionsApi(),
	});

	return { ...base, refreshModels };
}

/** Pi extension entry point. */
export default async function bifrostProvider(pi: ExtensionAPI): Promise<void> {
	pi.registerFlag("bifrost-url", {
		description: "Bifrost instance or OpenAI-compatible base URL (env: BIFROST_URL)",
		type: "string",
	});
	pi.registerFlag("bifrost-api-key", {
		description: "Bifrost API/auth key (optional; prefer env: BIFROST_API_KEY)",
		type: "string",
	});
	pi.registerFlag("bifrost-virtual-key", {
		description: "Bifrost virtual key (optional; prefer env: BIFROST_VIRTUAL_KEY)",
		type: "string",
	});
	const flag = (name: string): string | undefined => {
		const value = pi.getFlag(name);
		return (typeof value === "string" ? nonEmpty(value) : undefined) ?? flagFromArgv(name);
	};
	const config = optionalConfigFromEnvironment(process.env, {
		url: flag("bifrost-url"),
		apiKey: flag("bifrost-api-key"),
		virtualKey: flag("bifrost-virtual-key"),
	});
	const models = config
		? await fetchBifrostModels(config, { signal: AbortSignal.timeout(15_000) })
		: undefined;

	pi.registerProvider(createBifrostProvider({ config, models }));
}
