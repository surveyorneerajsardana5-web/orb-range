
## Upstox token settings update (2026-10-24)
- Added a Settings panel to enter an Upstox access token, verify it against `/v2/user/profile`, and persist it in a local ignored credential file with restrictive file permissions.
- Token is never returned to the browser; the UI shows only a masked suffix. Credential management routes reject non-loopback clients.
- Updated `.env.example` to remove the token-like sample value; token is blank by default.
- `npm run test:all`: PASS (syntax checks and existing safety/guard tests; 14 safety tests and 5 guard tests passed).
- Runtime smoke check: server started; token status endpoint returned `configured:false` with no token; malformed token was rejected. A valid-token save was not tested because no real token was supplied.
- Token saving does not enable live orders or auto B1 execution. Upstox access tokens can expire daily at 3:30 AM IST, so an expired token must be replaced from Settings.
