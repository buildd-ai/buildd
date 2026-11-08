# payments client

Calls the payment gateway. The gateway does not de-duplicate requests and
accepts no idempotency key: sending `POST /charges` twice charges the card
twice. `POST /charges/search` is a read and is safe to repeat.

The change under review adds retry with backoff for transient gateway errors.
