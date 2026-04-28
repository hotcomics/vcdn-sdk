# Publish từng package lên npm (từ đầu)

Hướng dẫn cho workspace `repos/sdk`: **chỉ publish** `@vcdn/sdk-shared`, `@vcdn/browser`, `@vcdn/node`. **Không** publish package root `vcdn-sdk-workspace` (giữ `"private": true` trong `package.json` gốc).

## 1. Chuẩn bị tài khoản npm

1. Tạo tài khoản [npmjs.com](https://www.npmjs.com) (nếu chưa có).
2. Bật **2FA** (Account → Two-Factor Authentication) — npm bắt buộc khi publish (hoặc dùng **Granular Access Token** có quyền publish + tùy chọn bypass 2FA cho CI).
3. Scope **`@vcdn`**: tạo **organization** hoặc **user** trùng tên scope trên npm, và tài khoản bạn dùng phải có quyền publish các package `@vcdn/*` (owner hoặc được add vào team).

Nếu scope thuộc org: trên npm → Organization → Packages → đảm bảo role cho phép publish.

## 2. Đăng nhập CLI

```bash
npm whoami
```

Nếu chưa đăng nhập hoặc sai account:

```bash
npm logout
npm login
```

Làm theo hướng dẫn (OTP nếu bật 2FA).

**Token (CI / không nhập OTP):** npm → Access Tokens → Granular token → quyền publish cho đúng package →:

```bash
npm config set //registry.npmjs.org/:_authToken=TOKEN_CỦA_BẠN
```

## 3. Môi trường build

Trong thư mục `repos/sdk`:

```bash
cd repos/sdk   # hoặc đường dẫn tương đương trên máy bạn
pnpm install
```

Cần **Node ≥18** và **pnpm 9.x** (đã khai trong `packageManager`).

## 4. Tăng phiên bản (semver)

Sửa **`version`** trong từng `package.json` cần release:

- `shared/package.json` → `@vcdn/sdk-shared`
- `browser/package.json` → `@vcdn/browser`
- `node/package.json` → `@vcdn/node`

Thông thường nên **cùng bước patch/minor** cho cả ba nếu release một đợt (ví dụ đều `0.1.1`), trừ khi bạn chỉ sửa một package và bump riêng package đó (khi đó nhớ dependency `^x.y.z` trên npm phải khớp với bản `sdk-shared` đã publish).

## 5. Kiểm tra trước khi publish

```bash
pnpm run publish:check
```

Lệnh này chạy build + typecheck + pack thử vào `.artifacts/`. Sửa lỗi nếu có.

## 6. Publish theo thứ tự phụ thuộc

`browser` và `node` phụ thuộc `@vcdn/sdk-shared`. **Luôn publish `sdk-shared` trước.**

```bash
pnpm --filter @vcdn/sdk-shared publish --access public
pnpm --filter @vcdn/browser publish --access public
pnpm --filter @vcdn/node publish --access public
```

pnpm sẽ chạy `prepublishOnly` (build + typecheck) trong từng package trước khi gửi lên registry.

Nếu npm hỏi OTP / 2FA, nhập theo yêu cầu.

## 7. Xác minh

```bash
npm view @vcdn/sdk-shared version
npm view @vcdn/browser version
npm view @vcdn/node version
```

Hoặc mở trên web: `https://www.npmjs.com/package/@vcdn/node` (và tương tự cho từng package).

## 8. Lỗi thường gặp

| Triệu chứng | Hướng xử lý |
|-------------|-------------|
| `ERR_PNPM_GIT_UNCLEAN` | pnpm yêu cầu working tree sạch trước khi publish. **Commit hoặc stash** thay đổi, rồi chạy lại; hoặc tạm thời `pnpm ... publish --no-git-checks` (không khuyến nghị cho bản release chính thức). |
| `EPRIVATE` trên package root | Đừng chạy `npm publish` ở root; chỉ dùng `pnpm --filter ... publish` như trên. |
| `403` — 2FA required | Bật 2FA tài khoản npm hoặc dùng granular token đủ quyền publish. |
| `403` — không có quyền scope `@vcdn` | Kiểm tra org/npm user và quyền publish cho scope đó. |
| `404` / tên package đã tồn tại bởi người khác | Đổi scope (ví dụ `@tenorg-cua-ban/...`) và cập nhật `name` trong mọi `package.json` + import nội bộ. |

## 9. Người dùng cài bản mới

```bash
npm install @vcdn/browser@0.1.1
npm install @vcdn/node@0.1.1
```

(thay version đúng với bạn vừa publish.)

---

Tóm tắt một dòng: **đăng nhập npm → bump version → `pnpm run publish:check` → publish `sdk-shared` → `browser` → `node` với `--access public`.**
