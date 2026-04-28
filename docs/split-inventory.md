# SDK Split Inventory

## Source Of Truth

- Extracted from monorepo path `sdk/`.
- Packages included: `@vcdn/sdk-shared`, `@vcdn/browser`, `@vcdn/node`.

## External Contracts

- Public API target: upload-service `/api/v1/*` (includes MP4 multipart under `/api/v1/upload/*` and HLS under `/api/v1/videos/*`, e.g. `init-hls-upload`, segment `HEAD`/`PUT`, `playlist`, `complete`).
- Auth header required by SDK clients: `X-API-Key`.
- Base URL contract: origin only (no `/api/v1` suffix).

## Cross-Repo References Found In Platform

- `docs/developer-api.md` references SDK usage snippets.
- `frontend/apps/dashboard/src/features/docs/DocsPortalClient.tsx` contains SDK code examples and package names.

## Split Decision

- `sdk` repo keeps package code, publish metadata, and SDK-only docs/scripts.
- `platform-cdn` repo keeps runtime services and dashboard/docs portal; it consumes SDK as an external dependency.
