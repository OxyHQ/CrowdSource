# @oxyhq/crowdsource-express

Express middleware for receiving CrowdSource webhooks: raw-body capture, HMAC
verification, replay protection and typed events.

The package is currently empty: it is the boundary the middleware will be
published from, and it exports nothing until the signature contract is fixed.

## Rules

- The signature is computed over the RAW body. Any JSON parser mounted ahead of
  the verifier destroys the bytes it signs.
- Signatures are compared in constant time, and a timestamp more than five
  minutes from now is rejected before the comparison.
- Two secrets are accepted during rotation, so a rotation never drops an event.
- A verified event is acknowledged fast and processed out of band, and the event
  id is recorded so a redelivery is a no-op.
