# Tests

Run with `npm test`. Built on Node's built-in `node:test` runner invoked through `tsx` so we can use the same `.ts` extension imports as `src/`.

Each test creates its tmp state under `tests/.tmp/<test-name>-<pid>/` and cleans up in an `after()` hook. Tests must not depend on or mutate global state (no global git config, no installed packages, no env vars beyond what the test itself sets and unsets).
