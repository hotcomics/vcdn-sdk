# SDK Consumption Modes

## Publish To Registry

Chi tiết từng bước (tài khoản npm, 2FA, scope, thứ tự, xử lý lỗi): **[publish-npm.md](./publish-npm.md)**.

Tóm tắt:

1. `pnpm install` trong `repos/sdk`, rồi `pnpm run publish:check`
2. Publish theo thứ tự:
   - `pnpm --filter @vcdn/sdk-shared publish --access public`
   - `pnpm --filter @vcdn/browser publish --access public`
   - `pnpm --filter @vcdn/node publish --access public`

## Git Dependency Mode

Use git tag or commit SHA when registry publish is not available yet:

```json
{
  "dependencies": {
    "@vcdn/browser": "git+ssh://git@github.com/your-org/vcdn-sdk.git#v0.1.0",
    "@vcdn/node": "git+ssh://git@github.com/your-org/vcdn-sdk.git#v0.1.0"
  }
}
```

## Notes

- Git dependency mode requires committed build artifacts in `dist/`.
- Registry mode is the preferred production path for deterministic installs.

## HLS upload (`@vcdn/node`)

`VcdnClient` (exported from `@vcdn/node`) uploads a local HLS directory (one media `.m3u8` + `.ts` segments) via the upload-service public API — resumable `HEAD` checks, parallel segment uploads (clamped 5–10), retries, optional progress/metrics/checksum.

**SDK guide:** [hls-upload-node.md](./hls-upload-node.md) (layout rules, options, `VcdnHlsError` codes, example).

**HTTP contract and curl:** from repo root, `repos/backend/docs/developer-api.md` (HLS sections) and `repos/backend/infra/api/openapi-v1.yaml`.
