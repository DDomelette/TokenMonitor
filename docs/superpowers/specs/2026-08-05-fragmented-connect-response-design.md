# Fragmented CONNECT Response Design

## Goal

Make the HTTP CONNECT client accept valid proxy responses across arbitrary TCP fragmentation boundaries without starting TLS before the complete proxy response header has arrived, while bounding memory use and preserving bytes that belong to the tunneled stream.

## Current failure

`src/main/core/http.js` currently attaches `proxySocket.once('data')`, parses the first chunk as though it contains the full response, and immediately wraps the socket in TLS after a leading `HTTP/1.x 200` match. A split status line is rejected, and a split header can leave later proxy-header bytes to be interpreted as TLS records.

## Considered approaches

1. **Incremental buffer inside the existing request state machine — selected.** This keeps timeout, settlement, and transport ownership in one place and changes only the CONNECT-response stage.
2. **Extract a standalone streaming parser module.** This is easier to unit-test in isolation but adds a new public boundary for one small protocol state and risks separating parser decisions from socket lifecycle.
3. **Delegate CONNECT to an external proxy-agent dependency.** This would broaden dependency and transport behavior beyond the issue and overlap existing timeout and protocol constraints.

## Selected design

The CONNECT-response stage will use a named `data` handler and a `Buffer` accumulator. Each chunk is appended until `\r\n\r\n` is found. The response is not parsed and TLS is not started before that delimiter exists.

The complete proxy header, including the terminating delimiter, is limited to 32 KiB. If no delimiter is present once the accumulator exceeds that limit, or if the discovered header itself exceeds the limit, the request fails with a stable `PROXY_CONNECT_HEADER_TOO_LARGE` error and destroys the active socket. The existing CONNECT-response timeout continues to cover the whole stage and is not reset by partial chunks.

After a complete header is available, the first line is parsed as an HTTP/1.0 or HTTP/1.1 status line with a three-digit status code. Only 200 is accepted. Invalid or non-200 responses fail with a safe error containing only a control-character-stripped, length-limited status line; proxy headers and possible credentials are never included.

Before starting TLS, the raw socket is paused and the CONNECT `data` handler is removed. Any bytes after the header terminator are returned to the front of the socket's readable queue with `unshift()`. TLS is then created over the same socket, allowing it to consume those bytes as tunnel data rather than losing them or treating unconsumed proxy headers as TLS input.

## Error and lifecycle behavior

- TCP-connect, CONNECT-response, TLS-handshake, and HTTPS-request timers remain independent.
- Fragment arrival does not extend the CONNECT-response deadline.
- Every parser error uses the existing single-settlement path and active-transport destruction.
- The accumulated header buffer is released after completion or failure.
- No token, proxy authorization header, target response body, or raw binary tunnel data is logged or included in errors.

## Test strategy

Behavior tests will use a controllable fake socket and stubbed TLS/HTTPS boundaries to prove:

1. a valid 200 response split inside the status line and header terminator does not start TLS early and succeeds after the final fragment;
2. bytes following `\r\n\r\n` are passed back through `socket.unshift()` before TLS starts;
3. a fragmented non-200 response returns the proxy status error only after the full header arrives;
4. a header exceeding 32 KiB rejects once, destroys the socket, and never starts TLS.

The complete repository test suite, renderer build, and Electron/Xvfb smoke test remain required before merge.

## Scope boundary

This change does not add HTTPS-proxy transport, proxy authentication, HTTP/2 proxy negotiation, multiple CONNECT responses, or retry logic. It only corrects HTTP/1.x CONNECT response framing on the existing HTTP proxy path.
