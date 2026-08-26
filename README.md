# PlanRCM Backend

REST API NestJS + TypeScript cho PlanRCM. Repository này độc lập với frontend, tích hợp Google Gemini qua `@google/generative-ai`.

Chỉ endpoint gọi dịch vụ tốn phí mới có rate limit theo IP: `/api/v1/ai/*` và `/api/v1/itinerary/*` là 5 request/phút; `/api/v1/maps/*` có quota riêng (24 request/phút, Routes Matrix 8 request/phút). Auth, health, lịch sử plan và Market không bị throttle. Riêng khách chưa đăng nhập chỉ có **một lượt tạo itinerary mỗi 24 giờ/IP**; họ có thể xem kết quả nhưng không thể lưu hay tùy chỉnh.

## Thiết lập

```bash
npm install
cp .env.example .env
```

Thêm `GEMINI_API_KEY` vào `.env`. Model mặc định là `gemini-3.5-flash-lite`; có thể thay qua `GEMINI_MODEL`.

`GEMINI_API_KEY` chỉ được đọc ở backend qua `ConfigService` trong `AiService` và `ItineraryService`; không có biến `NEXT_PUBLIC_*` hay response API nào trả khóa này về frontend.

### Địa điểm và quãng đường từ Gemini

PlanRCM không gọi Google Maps Platform và không cần `GOOGLE_MAPS_API_KEY`. Gemini tạo gợi ý địa điểm, đối chiếu tên/khu vực, ước lượng tọa độ và quãng đường cho Market Plan. Các response địa điểm và quãng đường có `source: "gemini"`; tọa độ và thời gian di chuyển là ước lượng. URL mở bản đồ chỉ là link ngoài tạo từ tên địa điểm, không phải lời gọi Maps API.

### Google OAuth + Cloud Firestore

1. Tạo **Web OAuth client** trong Google Cloud, khai báo redirect URI đúng tuyệt đối: `http://localhost:3000/api/v1/auth/google/callback`. Callback là endpoint của NestJS (cổng backend), không phải cổng Next.js.
2. Bật Cloud Firestore cho cùng Firebase/Google Cloud project.
3. Điền `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `JWT_SECRET` và `FIREBASE_PROJECT_ID` theo `.env.example`.
4. Khi chạy local, đặt `GOOGLE_APPLICATION_CREDENTIALS` thành đường dẫn tuyệt đối tới service-account JSON nằm **ngoài repository**. Trên Cloud Run hoặc Firebase App Hosting, dùng Application Default Credentials của workload thay cho key file.

Sau khi đăng nhập, backend xác thực ID token Google, lưu session trong cookie `httpOnly`, và ghi plan riêng tư tại `users/{googleUserId}/plans/{planId}` trên Cloud Firestore. Khách không tạo document Firestore nào.

### Market Plan

Plan luôn mặc định là **riêng tư**. Chủ plan có thể gọi endpoint cập nhật trạng thái để chia sẻ. Khi đó backend atomically tạo bản public tại `marketPlans/{planId}`; bản này chỉ có tên, avatar Google (nếu có) và itinerary — không bao giờ có email. Khi chủ plan tắt chia sẻ, document public bị xóa còn bản lịch sử riêng tư vẫn giữ nguyên.

Market là endpoint công khai chỉ đọc, không cần session Google. Lịch sử của từng tài khoản và thao tác chia sẻ vẫn yêu cầu session hợp lệ.

## Chạy local

```bash
npm run start:dev
```

Server lắng nghe tại `http://localhost:3000`, mọi endpoint dùng prefix `/api/v1`.

## Endpoints

| Method | Path                                           | Mô tả                                                        |
| ------ | ---------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/api/v1/health`                               | Kiểm tra trạng thái API                                      |
| GET    | `/api/v1/auth/google`                          | Bắt đầu Google OAuth (`?returnTo=/itinerary` tùy chọn)       |
| GET    | `/api/v1/auth/me`                              | Lấy session hiện tại và trạng thái cấu hình OAuth            |
| POST   | `/api/v1/auth/logout`                          | Xóa cookie session                                           |
| POST   | `/api/v1/ai/plan`                              | Tạo kế hoạch từ Gemini                                       |
| POST   | `/api/v1/itinerary/generate`                   | Tạo lịch trình du lịch có cấu trúc                           |
| GET    | `/api/v1/plans`                                | Lịch sử plan của tài khoản Google đã đăng nhập               |
| PATCH  | `/api/v1/plans/:planId/visibility`             | Bật/tắt chia sẻ plan (`{ "isPublic": true }`), cần đăng nhập |
| GET    | `/api/v1/market/plans`                         | Tối đa 36 plan mới nhất đang được chia sẻ công khai          |
| GET    | `/api/v1/market/plans/:planId`                 | Chi tiết một plan công khai                                  |
| GET    | `/api/v1/maps/places/autocomplete?input=...`   | Gợi ý địa điểm từ Gemini                                     |
| GET    | `/api/v1/maps/places/:placeId`                 | Chi tiết địa điểm Gemini đã chuẩn hóa                        |
| GET    | `/api/v1/maps/reverse-geocode?lat=...&lng=...` | Ước lượng khu vực từ tọa độ bằng Gemini                      |
| POST   | `/api/v1/maps/routes/matrix`                   | Ước lượng quãng đường/thời gian bằng Gemini                  |

Ví dụ:

```bash
curl -X POST http://localhost:3000/api/v1/ai/plan \\
  -H 'Content-Type: application/json' \\
  -d '{"goal":"Lập kế hoạch ra mắt sản phẩm trong 4 tuần"}'
```

Tạo lịch trình từ vị trí:

```bash
curl -X POST http://localhost:3000/api/v1/itinerary/generate \\
  -H 'Content-Type: application/json' \\
  -d '{"lat":10.7769,"lng":106.7009,"packages":["foodie","chill"],"durationDays":2}'
```

Hoặc tạo lịch trình cho điểm đến đã chọn trước khi đến nơi (không cần quyền vị trí):

```bash
curl -X POST http://localhost:3000/api/v1/itinerary/generate \\
  -H 'Content-Type: application/json' \\
  -d '{"destination":"Đà Lạt, Lâm Đồng","packages":["foodie","relax"],"durationDays":2,"startDate":"2026-12-30"}'
```

Contract response được định nghĩa tại `src/shared/interfaces/itinerary.interface.ts`.

Response itinerary của tài khoản đã đăng nhập có thêm `savedPlanId`, xác nhận document đã được lưu vào Cloud Firestore.

Chia sẻ một plan đã lưu:

```bash
curl -X PATCH http://localhost:3000/api/v1/plans/PLAN_ID/visibility \\
  -H 'Content-Type: application/json' \\
  -H 'Cookie: planrcm_session=YOUR_SESSION_COOKIE' \\
  -d '{"isPublic":true}'
```

## Kiểm tra

```bash
npm run lint
npm test
npm run test:e2e
npm run build
```
# BE_planrcm
