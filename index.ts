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
/**
 * Placeholder baseUrl for models registered without a config (e.g. before
 * /login runs). It is never actually requested: resolve()'s auth.baseUrl
 * overrides it before any request is made.
 */
const UNRESOLVED_BASE_URL = "http://localhost/openai/v1";

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

/**
 * Extension CLI values are applied after factories run, so startup-time model
 * discovery reads argv directly. In the space-separated form (`--name value`),
 * a value beginning with `--` is treated as the next flag and ignored; use
 * `--name=value` to pass such a value.
 */
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

/**
 * Build a {@link BifrostConfig} from environment variables and explicit
 * overrides (overrides win). Returns `undefined` when no URL is available
 * from either source, rather than throwing.
 */
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

/**
 * Same as {@link optionalConfigFromEnvironment}, but throws when no
 * BIFROST_URL / --bifrost-url is configured instead of returning `undefined`.
 */
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

/**
 * Build request headers while allowing explicit per-request headers to win.
 *
 * A header value of `null` (for example Authorization when `config.apiKey`
 * is unset) actively suppresses pi's default header for that name — notably
 * the default Authorization pi would otherwise send — whereas simply
 * omitting the key from the result leaves pi's default in place. Callers
 * that issue raw fetches (not routed through pi) must filter out `null`
 * entries themselves before using this as a Headers/fetch init object, as
 * {@link fetchBifrostModels} does.
 */
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

/**
 * Bifrost/OpenRouter pricing is normally expressed in dollars per token.
 * Heuristic: values <= 0.01 are assumed to be per-token and are scaled by
 * 1,000,000 to get dollars per million tokens; values above that threshold
 * are assumed to already be per-million. This is ambiguous for genuine
 * per-million prices at or below $0.01 (e.g. very cheap models), which get
 * misread as per-token and inflated by 1,000,000x. There is no reliable way
 * to disambiguate from the number alone, so the threshold is a best guess.
 */
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

/**
 * Convert a Bifrost catalog entry into pi's provider model shape, or
 * `undefined` if the model has no id or is not chat-capable.
 *
 * `contextWindow` falls back through `model.context_length`,
 * `top_provider.context_length`, `max_input_tokens + max_output_tokens`, and
 * finally `per_request_limits.prompt_tokens` — the last of which is a
 * stand-in (a per-request cap), not a true context window. `maxTokens`
 * falls back similarly through `max_output_tokens`,
 * `top_provider.max_completion_tokens`, and
 * `per_request_limits.completion_tokens`. When none of a chain's sources are
 * available, `contextWindow`/`maxTokens` default to
 * {@link DEFAULT_CONTEXT_WINDOW} (128k) / {@link DEFAULT_MAX_TOKENS} (8k).
 */
export function toProviderModel(model: BifrostModel): BifrostProviderModel | undefined {
	const id = nonEmpty(model.id);
	if (!id || !isChatModel(model)) return undefined;

	const contextWindow =
		positiveInteger(
			model.context_length,
			model.top_provider?.context_length,
			model.max_input_tokens && model.max_output_tokens ? model.max_input_tokens + model.max_output_tokens : undefined,
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
			// Falling back to the input price when Bifrost omits cache-write
			// pricing underestimates providers that bill cache writes above
			// input (e.g. 1.25x on Anthropic). This is a deliberate
			// conservative default, not a true price.
			cacheWrite: pricePerMillion(model.pricing?.input_cache_write) ?? inputPrice,
		},
		contextWindow,
		maxTokens,
		// These OpenAI-compatibility flags are asserted for every model on the
		// assumption that Bifrost's OpenAI-compatible translation layer
		// normalizes them across upstream providers. This trusts the gateway
		// rather than verifying per-model support.
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

/**
 * Fetch and normalize the model catalog from a Bifrost instance's
 * `/models` endpoint. Throws on a non-OK response, an invalid response
 * shape, or an empty resulting catalog (deduplicated by id).
 */
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

	const models = data.map(toProviderModel).filter((model): model is BifrostProviderModel => model !== undefined);
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

	// "Owning" means the credential carries its own URL (from a prior
	// /login), so ambient fallbacks (env/argv config) must not leak into it.
	const ownsConfig = credentialUrl !== undefined;
	const key = nonEmpty(credential?.key);
	const apiKey = key && key !== PLACEHOLDER_API_KEY ? key : ownsConfig ? undefined : fallback?.apiKey;
	const credentialVirtualKey = nonEmpty(credential?.env?.BIFROST_VIRTUAL_KEY);
	const virtualKey = ownsConfig ? credentialVirtualKey : (credentialVirtualKey ?? fallback?.virtualKey);
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
	const catalog = runtimeModels(options.models ?? [], ambientConfig?.url ?? UNRESOLVED_BASE_URL);
	let pendingModels = catalog.length > 0 ? [...catalog] : undefined;

	// createProvider() below captures this `catalog` array by reference, so
	// updates must mutate it in place. Reassigning `catalog` to a new array
	// here would silently break model refresh (the provider would keep
	// pointing at the stale array).
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
				(model): model is BifrostRuntimeModel => model.provider === PROVIDER_ID && model.api === "openai-completions",
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
		name: "Bifrost AI Gateway",
		baseUrl: ambientConfig?.url,
		auth: {
			apiKey: {
				name: "Bifrost connection",
				async login(interaction) {
					interaction.notify({
						type: "info",
						message: "Configure the Bifrost gateway. API and virtual keys are optional.",
						links: [
							{ url: "https://docs.getbifrost.ai/overview", label: "Bifrost documentation" },
							{ url: "https://www.getmaxim.ai/bifrost", label: "Bifrost homepage" },
						],
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
	// Startup discovery is best-effort: a temporarily-down Bifrost must not
	// prevent the extension from loading. If it fails here, the provider is
	// still registered with `models: undefined`; refreshModels() (using
	// /login-persisted models or a later successful fetch) retries recovery.
	let models: BifrostProviderModel[] | undefined;
	if (config) {
		try {
			models = await fetchBifrostModels(config, { signal: AbortSignal.timeout(15_000) });
		} catch (error) {
			process.stderr.write(
				`pi-bifrost-provider: startup model discovery failed, continuing without a preloaded catalog: ${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
		}
	}

	pi.registerProvider(createBifrostProvider({ config, models }));
}
