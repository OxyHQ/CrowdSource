# Ecosystem activity

The backend publishes aggregate traffic and its infrastructure heartbeat to the
Oxy API, which broadcasts changes to the website dashboard. Collection runs in
the service process regardless of whether somebody opens the dashboard.

With `AWS_REGION` configured, the publisher uses the shared temporary AWS role
provider, including ECS and authenticated development/SSO roles. Oxy validates
its live application/environment binding (ADR 0049); own apps need no scopes or
customer keys. Missing region omits only telemetry. Missing/revoked identity is
reported through the shared publisher's retry policy and is not zero traffic.
The same provider supports live service introspection and session verification;
CrowdSource tenant binding, organization status and privileged roles remain
independent domain checks.

HTTP middleware is mounted before body parsers and routers, including public
routes, webhooks, failures and authenticated internal calls. Outgoing fetch and
Node HTTP requests are observed by the shared SDK, including requests made by
background workers. Socket.IO message sends and receives are observed where
this service exposes Socket.IO. Internal/external scope is independent of
inbound/outbound direction; media is a separate activity category.

Only bounded aggregate fields leave the service. No bodies, message contents,
user identifiers, tokens or IP addresses are added to activity events. Visitor
origins represent the Cloudflare edge PoP, not an IP-derived country. Infrastructure
location follows `AWS_REGION`; registration and graceful removal update the
shared inventory, and crashed instances expire through the API registry.

The publisher does not observe database wire traffic, raw TCP, HTTP/2, WebRTC,
or a separate process that has not installed the collector. These transports
must not be represented by fabricated lines.

## Cloudflare web traffic

The reviewer (`crowdsource-frontend`, `crowdsource.oxy.so`) and console
(`crowdsource-console`, `console.crowdsource.oxy.so`) Workers' traffic is
measured keylessly by Oxy from Cloudflare's own analytics; see OxyHQ/oxy
`docs/operations/cloudflare-web-activity.md`. The frontends hold no Oxy activity
secret and run no activity code: each Worker only hands the request to `ASSETS`.
The `OXY_EDGE_ACTIVITY_*` bindings were never provisioned and nothing reads them
now; if an operator ever finds one on a deployment, it can simply be deleted.
