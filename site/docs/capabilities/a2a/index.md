---
id: a2a
title: Agent2Agent (A2A) Traffic
sidebar_position: 9
---

:::caution Preview
Agent Router does not yet have a dedicated A2A route type. This page shows how to route [A2A](https://a2a-protocol.org/) agents through the gateway **today**, using only Envoy Gateway resources plus the `envoy.filters.http.a2a` filter that ships inside Envoy Proxy. The filter is alpha in Envoy and the recipe relies on `EnvoyPatchPolicy`, so treat this as a preview. A first-class `A2ARoute` API is being discussed in [issue #2070](https://github.com/theagentrouter/agent-router/issues/2070). The steps below were verified on 2026-09-16 with Envoy Gateway v1.9.0 (Envoy 1.39.0), Agent Router v1.1.0 and Kubernetes 1.32 on kind.
:::

:::info Help shape A2A support
Early adopters of A2A can already configure Envoy through Agent Router to handle A2A traffic with the approach on this page. The community is working on first-class A2A features and CRDs. If you want to help, or just want to tell us what your agents need, join the discussion on [GitHub](https://github.com/theagentrouter/agent-router/issues/2070), the [community Discord](https://discord.gg/xuxtPq43gZ), or the [weekly community meeting](https://docs.google.com/document/d/10e1sfsF-3G3Du5nBHGmLjXw5GVMqqCvFDqp_O65B0_w) held every Monday.
:::

## What you get

Following this page, an A2A agent behind the gateway gets:

- **Routing** for the agent card (`GET /.well-known/agent-card.json`) and the JSON-RPC endpoint, with hostnames, timeouts long enough for Server-Sent Events, and optional path rewriting.
- **Protocol validation** by Envoy's A2A filter: every POST on the route must be a JSON-RPC 2.0 envelope, and oversized bodies are rejected.
- **A2A fields in access logs and metrics**: the JSON-RPC `method` and `id` (and, for A2A 0.3 clients, task and context IDs) land in Envoy dynamic metadata; the filter also exposes `a2a.requests_rejected`, `a2a.invalid_json` and `a2a.body_too_large` counters.
- **Client authentication** (JWT, API key, external auth) on the RPC endpoint via `SecurityPolicy`, while the public card stays open.
- Optionally, a **gateway-served agent card** so clients discover the gateway URL rather than the agent's internal address.

What you do **not** get yet: aggregation of several agents behind one card, rewriting of the backend's own card, method-level authorization, or support for the gRPC and HTTP+JSON bindings. See [Limitations](#limitations).

## Prerequisites

- Agent Router installed following [Prerequisites](../../getting-started/prerequisites.md). The Envoy Gateway values file used there already sets `extensionApis.enableEnvoyPatchPolicy: true`.
- Envoy Gateway v1.8 or newer. The A2A filter exists since Envoy Proxy v1.38.0, which Envoy Gateway v1.8 ships; v1.9 ships Envoy 1.39. On an older proxy image the patched listener is rejected by Envoy, which takes every route on that listener down, so check the image before you start.
- An A2A agent speaking the JSON-RPC binding. The example below assumes it runs as `Service/research-agent` on port 8080 in namespace `default`.

:::warning
`EnvoyPatchPolicy` lets anyone with permission to create it inject arbitrary proxy configuration. Restrict it with RBAC as described in the [Envoy Gateway security note](https://gateway.envoyproxy.io/docs/tasks/extensibility/envoy-patch-policy/#security-warning). The A2A filter itself is marked alpha with an unknown security posture in Envoy: use it only where both clients and agents are trusted.
:::

## Step 1: Give A2A agents their own Gateway

The A2A filter is applied to a whole Envoy listener. Once enabled, every JSON `POST` on that listener is buffered and parsed as JSON-RPC, so an LLM route sharing the listener would have its chat-completion bodies parsed too and could hit the body size limit. Keep A2A traffic on a dedicated Gateway (or at least a dedicated listener):

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: a2a-gateway
  namespace: default
spec:
  gatewayClassName: envoy-ai-gateway-basic
  listeners:
    - name: http
      protocol: HTTP
      port: 80
```

If you must share a listener with other traffic, see [Advanced: enabling the filter per route](#advanced-enabling-the-filter-per-route).

## Step 2: Route the agent card and the RPC endpoint

One `HTTPRoute` with two **named** rules. The names matter: `SecurityPolicy` targets the `rpc` rule in Step 4 so the card stays public.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: research-agent
  namespace: default
spec:
  parentRefs:
    - name: a2a-gateway
  hostnames:
    - research.agents.example.com
  rules:
    # A2A discovery: the card is host-rooted, so one agent per hostname.
    - name: agent-card
      matches:
        - method: GET
          path:
            type: Exact
            value: /.well-known/agent-card.json
      backendRefs:
        - name: research-agent
          port: 8080
    # JSON-RPC endpoint. Streaming methods return text/event-stream and can run
    # for minutes, so raise the request timeouts (Envoy's default is 15s).
    - name: rpc
      matches:
        - method: POST
          path:
            type: Exact
            value: /a2a
      timeouts:
        request: 30m
        backendRequest: 30m
      backendRefs:
        - name: research-agent
          port: 8080
```

If the agent serves its RPC endpoint on a different path, add a `URLRewrite` filter to the `rpc` rule. Do not attach request buffering (`BackendTrafficPolicy.requestBuffer`) to these routes; it stalls streaming responses.

## Step 3: Enable Envoy's A2A filter

`EnvoyPatchPolicy` inserts the filter into the listener's HTTP filter chain immediately before the router, so it runs after any authentication filters added by `SecurityPolicy`:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyPatchPolicy
metadata:
  name: a2a-filter
  namespace: default
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: a2a-gateway
  type: JSONPatch
  jsonPatches:
    - type: type.googleapis.com/envoy.config.listener.v3.Listener
      # <GatewayNamespace>/<GatewayName>/<ListenerName>. With the XDSNameSchemeV2
      # runtime flag enabled in Envoy Gateway this becomes "tcp-80".
      name: default/a2a-gateway/http
      operation:
        op: add
        # Selects the router filter; "add" at an array index inserts before it.
        jsonPath: "$..http_filters[?(@.name=='envoy.filters.http.router')]"
        value:
          name: envoy.filters.http.a2a
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.http.a2a.v3.A2a
            # PASS_THROUGH forwards non-A2A requests untouched.
            # REJECT answers them with 400; use it only on listeners that carry
            # nothing but JSON-RPC A2A traffic (see Limitations).
            traffic_mode: PASS_THROUGH
            # Bytes buffered while parsing the JSON-RPC envelope. Envoy's default
            # is 8192, which is too small for real messages; the maximum is 10485760.
            # Requests that exceed it get a 413 in both traffic modes.
            max_request_body_size: 1048576
```

Check that the patch was applied:

```shell
kubectl get envoypatchpolicy a2a-filter -o yaml | grep -A3 'type: Programmed'
```

Both `Accepted` and `Programmed` must be `True`. If the Gateway was created with `mergeGateways`, target the `GatewayClass` instead of the `Gateway`, as in the [Envoy Gateway task](https://gateway.envoyproxy.io/docs/tasks/extensibility/envoy-patch-policy/).

## Step 4: Protect the RPC endpoint, keep the card public

The card must be fetchable without credentials; the RPC endpoint usually must not. Target the `rpc` rule by `sectionName`:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: research-agent-rpc
  namespace: default
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: research-agent
      sectionName: rpc
  jwt:
    providers:
      - name: corp-idp
        issuer: https://idp.example.com
        audiences:
          - research-agent
        remoteJWKS:
          uri: https://idp.example.com/.well-known/jwks.json
```

`apiKeyAuth` and `extAuth` work the same way. Advertise the matching scheme in the agent card's `securitySchemes` so clients know what to send.

## Step 5: Log A2A fields

The filter writes its findings as dynamic metadata under the filter name. Add them to the access log in your `EnvoyProxy` resource, alongside the MCP fields from [Access Logs](../observability/accesslogs.md):

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: a2a-access-logs
  namespace: default
spec:
  telemetry:
    accessLog:
      settings:
        - sinks:
            - type: File
              file:
                path: /dev/stdout
          format:
            type: JSON
            json:
              a2a.method: "%DYNAMIC_METADATA(envoy.filters.http.a2a:method)%"
              jsonrpc.request.id: "%DYNAMIC_METADATA(envoy.filters.http.a2a:id)%"
              a2a.version: "%REQ(A2A-VERSION)%"
              # Populated for A2A 0.3 clients only; see Limitations.
              a2a.task.id: "%DYNAMIC_METADATA(envoy.filters.http.a2a:params:taskId)%"
              a2a.context.id: "%DYNAMIC_METADATA(envoy.filters.http.a2a:params:message:contextId)%"
              # Common fields
              start_time: "%START_TIME%"
              method: "%REQ(:METHOD)%"
              path: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"
              response_code: "%RESPONSE_CODE%"
              response_code_details: "%RESPONSE_CODE_DETAILS%"
              duration: "%DURATION%"
              upstream_cluster: "%UPSTREAM_CLUSTER%"
              route_name: "%ROUTE_NAME%"
```

Attach it to the Gateway through `spec.infrastructure.parametersRef`. Do not log the whole `envoy.filters.http.a2a` namespace: for 0.3 clients it contains the full message content.

Rejections show up in `response_code_details` as `a2a_filter_reject`, `a2a_filter_not_valid_jsonrpc`, `a2a_filter_parse_error` or `a2a_filter_body_too_large`, and in the proxy stats as `http.http-<port>.a2a.requests_rejected`, `.invalid_json` and `.body_too_large` (for example `http.http-10080.a2a.body_too_large`).

## Step 6: Verify

```shell
export GATEWAY_HOST=$(kubectl get gateway/a2a-gateway -o jsonpath='{.status.addresses[0].value}')

# Discovery
curl -s -H "Host: research.agents.example.com" \
  http://$GATEWAY_HOST/.well-known/agent-card.json | jq .name

# A2A 1.0 SendMessage (add the Authorization header if you applied Step 4)
curl -s -H "Host: research.agents.example.com" \
  -H "Content-Type: application/a2a+json" -H "A2A-Version: 1.0" \
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"hello"}]}}}' \
  http://$GATEWAY_HOST/a2a | jq .

# Protocol validation: a JSON body that is not JSON-RPC is forwarded in PASS_THROUGH
# mode and rejected with 400 in REJECT mode.
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: research.agents.example.com" \
  -H "Content-Type: application/json" -d '{"hello":"world"}' http://$GATEWAY_HOST/a2a
```

The access log line for the second request carries `"a2a.method": "SendMessage"`.

`kubectl port-forward` is fine for these one-shot calls, but it drops long-lived streams and any connection Envoy resets (for example after a 413). Test `SendStreamingMessage` from a pod inside the cluster or through a real load balancer; through the gateway a stream that the agent keeps open for 18 seconds arrives intact.

## Optional: serve the agent card from the gateway

A2A clients connect to whatever URL the card advertises. If the agent only knows its in-cluster address, its card sends clients around the gateway. Rather than rewriting the backend's card, serve a static one from the gateway with Envoy Gateway's direct response filter and point the `agent-card` rule at it:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: HTTPRouteFilter
metadata:
  name: research-agent-card
  namespace: default
spec:
  directResponse:
    statusCode: 200
    contentType: application/json
    body:
      type: Inline
      inline: |
        {
          "name": "Research Agent",
          "description": "Summarises research papers",
          "supportedInterfaces": [
            {"url": "https://research.agents.example.com/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}
          ],
          "capabilities": {"streaming": true},
          "defaultInputModes": ["text/plain"],
          "defaultOutputModes": ["text/plain"],
          "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer"}},
          "skills": []
        }
```

```yaml
- name: agent-card
  matches:
    - method: GET
      path:
        type: Exact
        value: /.well-known/agent-card.json
  filters:
    - type: ExtensionRef
      extensionRef:
        group: gateway.envoyproxy.io
        kind: HTTPRouteFilter
        name: research-agent-card
```

## Advanced: enabling the filter per route

If the A2A route must share a listener with other traffic, insert the filter **disabled** and enable it only on the A2A routes. This is the same mechanism Agent Router uses for its own filters.

1. In the listener patch above, add `disabled: true` next to `typed_config`.
2. Add a second patch against the route configuration. Envoy Gateway names xDS routes `httproute/<namespace>/<name>/rule/<index>/match/<index>/<hostname>`, so a regular expression on the route name selects the rules you want. Patch the filter's own key under `typed_per_filter_config`: Envoy Gateway creates the map when the route has none and leaves other entries (for example the `SecurityPolicy` API-key config) untouched.

```yaml
- type: type.googleapis.com/envoy.config.route.v3.RouteConfiguration
  name: default/a2a-gateway/http
  operation:
    op: add
    # Only the rpc rule needs the filter; the card is a bodyless GET anyway.
    jsonPath: "$..routes[?(@.name =~ 'httproute/default/research-agent/rule/1/')]"
    path: /typed_per_filter_config/envoy.filters.http.a2a
    value:
      "@type": type.googleapis.com/envoy.config.route.v3.FilterConfig
      # An empty config enables a filter that is disabled at the listener.
      config: {}
```

With this in place the filter parses bodies on the `rpc` route only: a 1.5 MiB non-A2A body sent to another `HTTPRoute` on the same listener is forwarded, while the same body on `/a2a` gets a 413. Rule indexes follow the order of `rules` in the `HTTPRoute`, so keep the patch and the route in the same file. Confirm the result with `kubectl get envoypatchpolicy` (both conditions `True`) and the Envoy admin `config_dump`. This bookkeeping is exactly what a native `A2ARoute` will remove.

## Limitations

- **Alpha filter, unknown security posture.** Envoy marks the A2A filter alpha and its API work-in-progress; both the config and the behaviour may change between Envoy releases.
- **A2A 1.0 method names are not fully modelled yet.** The filter's per-method extraction rules use the A2A 0.3 names (`message/send`, `tasks/get`, ...). Requests from 1.0 clients (`SendMessage`, `GetTask`, ...) are still validated and their `method` and `id` are logged, but `taskId` and `contextId` are only extracted for 0.3 traffic. Envoy follow-ups are tracked in proposal 013.
- **`parser_config` and `storage_mode` are accepted but ignored** by the current filter implementation. Do not set them.
- **Body size limit applies in both modes.** A request whose JSON-RPC envelope cannot be completed within `max_request_body_size` gets a 413 even in `PASS_THROUGH`. For 0.3 clients the parser walks the whole `params.message.parts` array, so inline file parts must fit under the limit.
- **`REJECT` is for JSON-RPC-only listeners.** The gRPC and HTTP+JSON bindings do not carry JSON-RPC envelopes and would be answered with 400. Route those with `GRPCRoute` / plain `HTTPRoute` on a listener without the filter.
- **One card per hostname.** The well-known path is host-rooted. Put each agent on its own hostname, or skip the `agent-card` rule for agents discovered through a registry.
- **No card rewriting, no aggregation.** Use the static card above, or configure the agent with its public URL.
- **`aigw run` (standalone) is not covered** by this page.
