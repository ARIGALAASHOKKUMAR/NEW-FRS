# Node.js attendance API

Run the API from this directory with `npm start`. It listens on port `5001` by default. The app uses the same port; on a physical phone it discovers the host address from the Expo dev server.

## Local configuration

Copy `.env.example` to `.env` and set a private `JWT_SECRET`. For production, set `ADMIN_EMAIL` and an `ADMIN_PASSWORD` of at least 12 characters for the first administrator. The development seed account is `admin@attendance.local` / `admin123`; replace it before deployment. Do not commit `.env`.

When `FACE_PROVIDER_URL` is blank, the Node API automatically starts a local face service on loopback. It downloads the YuNet, SFace, and MediaPipe models on first start; no API key or external recognition account is required. Install the Python dependencies from this directory before starting the API:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

The local service stores face embeddings under the ignored `backend/data/` directory. If you use an external provider instead, set its base URL and private API key in `backend/.env`; never put the key in the Expo app.

## API routes

All routes use the `/api` prefix. Protected routes require `Authorization: Bearer <access_token>`.

| Method | Route | Access |
| --- | --- | --- |
| GET | `/health` | Public |
| POST | `/auth/login` | Public |
| POST | `/auth/refresh` | Authenticated |
| POST | `/auth/register` | Administrator |
| GET | `/employees/me` | Authenticated |
| POST | `/face/enroll` | Authenticated employee; administrator may enroll a target employee |
| POST | `/face/verify` | Authenticated |
| GET | `/office-locations` | Public |
| POST | `/attendance/process` | Authenticated; requires a one-use face token and UUID idempotency key |
| GET | `/attendance/today` | Authenticated |
| GET | `/attendance/history` | Authenticated |
| GET | `/admin/overview` | Administrator |
| GET | `/admin/employees` | Administrator |
| PATCH | `/admin/employees/:employeeId/status` | Administrator |
| POST | `/admin/employees/:employeeId/face-reset` | Administrator |
| POST | `/admin/reset-all-data` | Administrator; destructive |
| GET | `/admin/attendance` | Administrator |
| GET | `/admin/attendance.csv` | Administrator |
| GET / PUT | `/admin/attendance-rules` | Administrator |
| GET / PUT | `/admin/office-location` | Administrator |
| GET | `/admin/audit-logs` | Administrator |

Attendance is limited to one check-in and one check-out per employee for each day in the configured office timezone. Check-in is not blocked by the scheduled arrival time; lateness is recorded as a reportable value.

The dashboard's **Reset all app data** action deletes all employee accounts, face templates, attendance records, and audit history. It preserves office settings and creates a fresh administrator from `ADMIN_EMAIL` and `ADMIN_PASSWORD` (or the development defaults). This reset is available only with the local face provider because external providers need their own template-deletion contract.

## Face liveness and recognition provider

The local provider compares SFace embeddings against the enrolled face and uses MediaPipe landmarks to require an open-close-open blink in the recorded video. It also checks that the face in the video matches the still image/template. It is a development convenience, not production-grade presentation-attack detection; a blink check can be spoofed with a replay, and employment attendance should use a security-reviewed, consent-based system before production. The API also supports external providers that implement the enrollment and verification contract below.

Enrollment request:

```json
{
  "employee_id": "EMP-1001",
  "image_base64": "<captured still image>",
  "liveness_video_base64": "<short blink challenge video>",
  "liveness_video_mime_type": "video/mp4"
}
```

The enrollment response must include `liveness_passed: true` and a string `template_id` (or `template`). Verification receives the same image/video fields and must return `matched: true`, `liveness_passed: true`, a numeric `confidence` at or above `FACE_MATCH_THRESHOLD`, and an `employee_id` exactly matching the authenticated employee. A missing or different employee ID is rejected.

The Expo Go camera records a short challenge clip while the employee blinks. Expo Camera does not detect eye blinks itself; the backend-side local provider analyzes the captured video.

The JSON store in `data/attendance.json` is for local development only. PostgreSQL/Prisma migration and a licensed, validated on-device face model are not configured by this development implementation. Do not use this JSON store or the sample administrator account for production attendance or biometric data.
