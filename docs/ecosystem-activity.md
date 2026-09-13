# Ecosystem activity

The backend publishes aggregate traffic and its infrastructure heartbeat to the
Oxy API, which broadcasts changes to the website dashboard. Collection runs in
the service process regardless of whether somebody opens the dashboard.

Enable with `OXY_ECOSYSTEM_ACTIVITY_ENABLED=true`, `AWS_REGION`, and a registered
Oxy application credential (`OXY_SERVICE_API_KEY` and `OXY_SERVICE_API_SECRET`).
An invalid activation value or missing required configuration fails at boot.
Disabled collection emits a warning; it must not be interpreted as zero traffic.
Provision credentials and enable the flag in the deployment before claiming coverage.

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
