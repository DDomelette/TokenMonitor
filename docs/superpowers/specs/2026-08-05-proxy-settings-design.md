# Proxy Settings Design

## Goal

Replace the forced `http://127.0.0.1:7890` default with an explicit network policy that users can configure as direct, system, or custom HTTP proxy. Invalid custom values must be rejected before persistence and surfaced in the settings window.

## Stored representation

The existing `providers.proxyUrl` key remains the only persisted field:

- `''` means direct connection.
- `'system'` means resolve the operating-system/Chromium proxy for each target URL.
- A normalized `http://host[:port]` value means a custom HTTP CONNECT proxy.

This representation avoids a migration ambiguity for existing custom proxy users. Existing HTTP URLs remain custom automatically. New installations default to `''`.

## Validation boundary

A new pure `proxy-settings` module owns all proxy policy validation and interpretation.

Custom proxy input:

- requires an `http://` URL;
- requires a hostname and valid port;
- rejects HTTPS and SOCKS schemes because the shared client cannot transport them;
- rejects credentials, path segments, query strings, and fragments;
- normalizes the stored value before any write.

`settings-write.js` applies this normalization whenever `providers.proxyUrl` is written, so legacy `settings:update`, acknowledged `settings:save`, and future callers cannot bypass validation.

## System proxy resolution

Electron `session.defaultSession.resolveProxy(targetUrl)` is called at request time, preserving PAC rules that vary by destination. The returned directive list is converted as follows:

- `DIRECT` becomes a direct connection.
- `PROXY host:port` becomes `http://host:port` for the shared HTTP CONNECT client.
- Unsupported directives such as `SOCKS` or `HTTPS` fail with a bounded configuration error rather than silently bypassing the configured proxy.

The shared HTTP client accepts its existing string/null proxy input plus a target-aware resolver function or promise. When a resolver is supplied, the client invokes it with the actual request URL, awaits the result, and then follows its existing direct or CONNECT path. Existing direct and custom callers remain unchanged.

## Main-process integration

System-proxy interpretation is centralized at the network boundaries rather than copied through application lifecycle code:

- the scheduler maps the stored `'system'` sentinel to `resolveElectronSystemProxy` before exposing `getProxyUrl()` to every Provider;
- DeepSeek API-key verification maps the same sentinel at the balance transport boundary;
- the shared HTTP client resolves the resulting function against the concrete target URL.

All normal polling, manual refresh, DeepSeek balance verification, usage fallback, and historical backfill therefore consume the same live stored policy. Changing the setting affects the next request without restarting the app.

## Settings UI

The settings definitions add a dedicated network row with:

- mode selector: Direct, System Proxy, Custom HTTP Proxy;
- custom URL input enabled only for custom mode;
- explicit Apply button;
- inline success/error feedback.

The UI derives the mode from the stored representation and sends the canonical candidate through the existing acknowledged `settings:save` channel. Renderer checks improve feedback, but the main-process validation remains authoritative. The custom address input has no generic settings key, so intermediate typing never enters the debounced settings queue.

## Error handling

- Invalid custom input leaves the old setting untouched and shows an inline error.
- System proxy resolution failures propagate as Provider request failures and are converted by the existing safe error summarizer.
- Unsupported system proxy directives never expose the raw PAC string to the renderer.
- Empty custom input is invalid; users select Direct to disable the proxy.

## Testing

Tests cover:

- direct, system, and custom normalization;
- invalid schemes, credentials, paths, queries, and ports;
- system `DIRECT` and `PROXY` directives plus unsupported directives;
- asynchronous target-aware resolution in the shared HTTP client;
- save-before-write validation and no broadcast on failure;
- new-install defaults;
- settings UI mode/address controls and feedback;
- scheduler polling and API-key verification receiving the stored system policy as a resolver;
- full existing CI, renderer build, and Electron/Xvfb smoke.

## Scope

This change does not add proxy authentication, SOCKS transport, HTTPS-proxy transport, per-Provider proxy settings, or automatic failover across multiple PAC directives. Those require separate transport designs.
