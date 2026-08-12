# pi-bifrost-provider

A [pi](https://pi.dev) provider for [Bifrost](https://docs.getbifrost.ai/overview). It discovers models from Bifrost and sends requests through Bifrost's OpenAI Chat Completions integration.

## Configuration

### Interactive setup (recommended)

Load the extension, then use Pi's standard login flow:

```text
pi -e ./index.ts
/login bifrost
```

Pi prompts for:

1. **Bifrost URL** — required, for example `http://localhost:8080`
2. **API key** — optional
3. **Virtual key** — optional

The connection is stored in Pi's credential store. Model discovery runs during login, and the resulting model catalog is persisted for future sessions. Run `/login bifrost` again to change the connection.

### Non-interactive setup

| Environment variable | CLI option | Required | Description |
| --- | --- | --- | --- |
| `BIFROST_URL` | `--bifrost-url` | Yes | Bifrost instance URL, such as `http://localhost:8080`. An existing `/v1` or `/openai/v1` base URL is also accepted. |
| `BIFROST_API_KEY` | `--bifrost-api-key` | No | API key or Bifrost authentication token. Sent as `Authorization: Bearer ...`. |
| `BIFROST_VIRTUAL_KEY` | `--bifrost-virtual-key` | No | Bifrost virtual key. Sent as `x-bf-vk`, so it can be used together with API authentication. |

CLI options override environment variables. Environment variables are recommended for secrets because command-line values may be visible in shell history and process listings. Stored `/login` credentials take precedence over ambient configuration.

At least one model provider must already be configured in Bifrost. When a virtual key is supplied, model discovery only returns models allowed by that key.

## Usage

Environment-based configuration from this checkout:

```bash
export BIFROST_URL=http://localhost:8080
export BIFROST_API_KEY=your-api-key          # optional
export BIFROST_VIRTUAL_KEY=sk-bf-...         # optional

pi -e ./index.ts
```

Or pass the parameters directly (prefer environment variables or `/login` for secrets):

```bash
pi -e ./index.ts \
  --bifrost-url http://localhost:8080 \
  --bifrost-api-key your-api-key \
  --bifrost-virtual-key sk-bf-...
```

Then select a `bifrost/*` model with `/model`, or start directly with one:

```bash
pi -e ./index.ts --provider bifrost --model 'anthropic/claude-*'
```

Install as a pi package from a Git repository:

```bash
pi install git:https://github.com/OWNER/pi-bifrost-provider
```

After installation, start Pi and run `/login bifrost`, or configure the environment variables for non-interactive use.

### URL behavior

For an instance URL such as `http://localhost:8080`, the extension uses:

- `http://localhost:8080/openai/v1/models` for model discovery
- `http://localhost:8080/openai/v1/chat/completions` for inference

If `BIFROST_URL` already ends in `/v1` (for example, `http://localhost:8080/v1`), it is used as-is. This permits Bifrost's unified OpenAI-compatible endpoint and reverse-proxy mounts.

## Authentication combinations

- **Neither key:** keyless Bifrost instance.
- **API key only:** Bearer authentication.
- **Virtual key only:** governance/routing via `x-bf-vk` without a bogus Authorization header.
- **Both:** Bearer authentication plus `x-bf-vk`, as required when Bifrost inference authentication and governance are both enabled.

You can temporarily override `BIFROST_API_KEY` with pi's `--api-key` option. The virtual key still comes from `BIFROST_VIRTUAL_KEY`.

## Model metadata

The provider maps Bifrost's model-list response into pi model definitions, including context/output limits, text/image input support, reasoning efforts, and token pricing when Bifrost reports those fields. Models that advertise only non-chat methods (for example embeddings) are omitted.

## Testing

Both test modes run the same complete `*.test.ts` suite. Tests that exercise a backend select it from `BIFROST_TEST_MODE`; pure unit tests run unchanged in both modes.

### Mock mode

```bash
npm test
```

The runner sets `BIFROST_TEST_MODE=mock`. Backend-aware discovery, login, and streaming scenarios use in-process `fetch` mocks, so no external processes or provider credentials are needed.

### Integration mode

```bash
npm run test:integration
```

The runner performs the complete fixture lifecycle:

1. Starts [aimock](https://github.com/CopilotKit/aimock) with `test/fixtures/aimock.json`.
2. Writes a temporary, file-only Bifrost configuration that routes OpenAI requests to aimock.
3. Starts Bifrost with `npx -y @maximhq/bifrost`.
4. Runs the same full test suite with `BIFROST_TEST_MODE=integration` and `BIFROST_TEST_URL` set to the fixture.
5. Stops both process trees and removes the temporary app directory, even when tests fail.

This makes the backend-aware scenarios in `test/provider.test.ts` run through the real `Pi provider → Bifrost → aimock` path instead of a separate smoke test.

The fixture uses available ephemeral ports by default. Its bind addresses, client-visible hosts, ports, packages, and startup behavior are configurable:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BIFROST_TEST_BIND_HOST` | `127.0.0.1` | Address passed to Bifrost's `-host`. |
| `BIFROST_TEST_HOST` | bind host | Host used by tests to reach Bifrost. Useful when the bind address is `0.0.0.0` or the fixture is reached through another hostname. |
| `BIFROST_TEST_PORT` | available ephemeral port | Bifrost listening port. |
| `AIMOCK_TEST_BIND_HOST` | `127.0.0.1` | Address passed to aimock's `--host`. |
| `AIMOCK_TEST_HOST` | bind host | Host written into Bifrost's upstream URL. |
| `AIMOCK_TEST_PORT` | available ephemeral port | aimock listening port. |
| `BIFROST_TEST_PACKAGE` | `@maximhq/bifrost` | Bifrost npm package specification, optionally pinned. |
| `AIMOCK_TEST_PACKAGE` | `@copilotkit/aimock` | aimock npm package specification, optionally pinned. |
| `BIFROST_TEST_START_TIMEOUT_MS` | `120000` | Readiness timeout for each fixture process. |
| `BIFROST_TEST_VERBOSE` | unset | Set to `1` to print fixture process logs. |

For example:

```bash
BIFROST_TEST_BIND_HOST=0.0.0.0 \
BIFROST_TEST_HOST=127.0.0.1 \
BIFROST_TEST_PORT=18080 \
AIMOCK_TEST_PORT=14010 \
BIFROST_TEST_PACKAGE=@maximhq/bifrost@1.6.3 \
AIMOCK_TEST_PACKAGE=@copilotkit/aimock@1.38.0 \
npm run test:integration
```

To keep the same managed fixture running for manual `/login bifrost` testing, use:

```bash
npm run fixture
```

The command prints its dynamically selected `BIFROST_TEST_URL` and keeps the fixture alive until Ctrl+C. A standalone zero-config Bifrost instance remains available with `npm run bifrost`.

The first fixture run requires network access for `npx`; subsequent runs can reuse npm's cache.

## Development

```bash
npm install
npm run check
npm test
npm run test:integration
```
