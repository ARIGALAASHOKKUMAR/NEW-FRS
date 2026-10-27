import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import multer from 'multer';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore, saveStore } from './db.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5001);
const JWT_SECRET = process.env.JWT_SECRET || 'replace-with-your-real-secret-key';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
if (process.env.NODE_ENV === 'production' && (JWT_SECRET === 'replace-with-your-real-secret-key' || JWT_SECRET.length < 32)) {
  throw new Error('Set a unique JWT_SECRET of at least 32 characters before running the backend in production.');
}
const USE_LOCAL_FACE_PROVIDER = !process.env.FACE_PROVIDER_URL;
const FACE_PROVIDER_URL = (process.env.FACE_PROVIDER_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const FACE_PROVIDER_API_KEY = process.env.FACE_PROVIDER_API_KEY;
const FACE_ENROLL_PATH = process.env.FACE_ENROLL_PATH || '/enroll';
const FACE_VERIFY_PATH = process.env.FACE_VERIFY_PATH || '/verify';
const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || (USE_LOCAL_FACE_PROVIDER ? 0.363 : 0.85));
const uploadLivenessVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});
const usedFaceVerificationTokens = new Set();

const OFFICE = {
  latitude: Number(process.env.OFFICE_LATITUDE || 16.422708),
  longitude: Number(process.env.OFFICE_LONGITUDE || 80.560739),
  radiusMeters: Number(process.env.OFFICE_RADIUS_METERS || 100),
  timezone: process.env.TIMEZONE || 'Asia/Kolkata',
};

const allowedWebOrigins = (process.env.CORS_ORIGINS || 'http://localhost:8081,http://127.0.0.1:8081')
  .split(',')
  .map((origin) => origin.trim());
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const faceRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});
const registrationSchema = z.object({
  employee_id: z.string().trim().min(1).max(80),
  full_name: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
  department: z.string().trim().min(1).max(120),
  designation: z.string().trim().min(1).max(120),
  office_assignment: z.string().trim().min(1).max(120).optional(),
}).strict();
const attendanceSchema = z.object({
  action: z.enum(['check_in', 'check_out']),
  face_verification_token: z.string().min(1),
  idempotency_key: z.string().uuid().optional(),
  location: z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracy: z.number().finite().min(0),
  }).strict(),
}).strict();
const resetSchema = z.object({
  scope: z.enum(['attendance', 'employee_face', 'all']),
  employee_id: z.union([z.string(), z.number()]).optional(),
}).strict();

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedWebOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'OPTIONS'],
}));
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Store + migration: guarantee every employee has a string employee_id.
// ---------------------------------------------------------------------------
const store = loadStore();
const employees = store.employees;
const attendanceRecords = store.attendanceRecords;
const auditLogs = store.auditLogs;

let storeMigrated = false;
for (const emp of employees) {
  if (emp.employee_id == null || String(emp.employee_id).trim() === '') {
    emp.employee_id = `EMP-LEGACY-${emp.id}`;
    storeMigrated = true;
    console.warn(`[migration] employee id=${emp.id} → employee_id=${emp.employee_id}`);
  } else if (typeof emp.employee_id !== 'string') {
    const before = emp.employee_id;
    emp.employee_id = String(emp.employee_id).trim();
    storeMigrated = true;
    console.warn(`[migration] employee id=${emp.id} employee_id ${typeof before} → string (${emp.employee_id})`);
  }
}
if (storeMigrated) saveStore(store);

if (store.officeLocation) Object.assign(OFFICE, store.officeLocation);
const attendanceRules = store.attendanceRules || {
  checkInTime: '10:30',
  checkOutTime: '18:30',
  minimumWorkingMinutes: 480,
  timezone: OFFICE.timezone,
};
store.attendanceRules = attendanceRules;

const bootstrapAdminEmail = process.env.ADMIN_EMAIL || (process.env.NODE_ENV === 'production' ? '' : 'admin@attendance.local');
const bootstrapAdminPassword = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'admin123');

function createBootstrapAdmin(id) {
  return {
    id,
    employee_id: String(process.env.ADMIN_EMPLOYEE_ID || 'EMP-1001'),
    full_name: 'System Administrator',
    email: bootstrapAdminEmail,
    department: 'Operations',
    designation: 'Engineer',
    office_assignment: 'Main Office',
    role: 'admin',
    active: true,
    passwordHash: bcrypt.hashSync(bootstrapAdminPassword, 12),
    face_status: 'pending',
    face_embedding: null,
    created_at: new Date().toISOString(),
  };
}

if (!employees.some((employee) => employee.role === 'admin')) {
  if (!bootstrapAdminEmail || !bootstrapAdminPassword || (bootstrapAdminPassword.length < 12 && process.env.NODE_ENV === 'production')) {
    throw new Error('Configure ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters to bootstrap an administrator.');
  }
  employees.push(createBootstrapAdmin(employees.reduce((max, employee) => Math.max(max, employee.id), 0) + 1));
  saveStore(store);
}

function generateToken(employee) {
  return jwt.sign(
    {
      sub: employee.email,
      employee_id: employee.employee_id,
      role: employee.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Missing or invalid token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.employee = employees.find((employee) => employee.email === decoded.sub) || null;

    if (!req.employee) {
      return res.status(401).json({ message: 'Employee not found' });
    }
    if (req.employee.active === false) {
      return res.status(403).json({ message: 'This employee account is inactive' });
    }

    next();
  } catch {
    return res.status(401).json({ message: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.employee?.role !== 'admin') {
    return res.status(403).json({ message: 'Administrator access is required' });
  }
  return next();
}

function normalizeBase64(value = '') {
  if (!value) return '';
  return value.startsWith('data:image') ? value.split(',')[1] || '' : value;
}

function parseImageData(imageBase64 = '') {
  const normalized = normalizeBase64(imageBase64);
  if (!normalized) throw new Error('Face image is required');
  return normalized;
}

function normalizeEmployeeId(value) {
  if (value == null) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  return String(value).trim();
}

function createFaceVerificationToken(employee, action) {
  const verificationId = crypto.randomUUID();
  const token = jwt.sign(
    {
      sub: employee.email,
      employee_id: employee.employee_id,
      action,
      purpose: 'attendance-face-verification',
      jti: verificationId,
    },
    JWT_SECRET,
    { expiresIn: '2m' }
  );
  return { token, verificationId };
}

async function callFaceProvider(path, payload) {
  // Defense-in-depth: always send a trimmed string employee_id.
  if (payload && 'employee_id' in payload) {
    payload.employee_id = normalizeEmployeeId(payload.employee_id);
  }
  console.log(`[face-provider] POST ${path} employee_id=${JSON.stringify(payload?.employee_id)}`);

  let response;
  try {
    response = await fetch(`${FACE_PROVIDER_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(FACE_PROVIDER_API_KEY ? { 'x-api-key': FACE_PROVIDER_API_KEY } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90000),
    });
  } catch (cause) {
    const error = new Error(USE_LOCAL_FACE_PROVIDER
      ? 'The local face service is unavailable. Check the backend terminal for model setup errors.'
      : cause.message);
    error.statusCode = USE_LOCAL_FACE_PROVIDER ? 503 : 502;
    throw error;
  }
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(result.message || `Face service returned HTTP ${response.status}`);
    error.statusCode = USE_LOCAL_FACE_PROVIDER ? response.status : 502;
    throw error;
  }
  return result;
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * earthRadiusKm * 1000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function computeLateMinutes(checkInTime) {
  const checkIn = parseDateTime(checkInTime);
  if (!checkIn) return 0;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: attendanceRules.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(checkIn);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const checkInMinutes = Number(values.hour) * 60 + Number(values.minute);
  const [scheduledHour, scheduledMinute] = attendanceRules.checkInTime.split(':').map(Number);
  return Math.max(0, checkInMinutes - (scheduledHour * 60 + scheduledMinute));
}

function officeDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: attendanceRules.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function writeAuditLog(actor, action, entityType, entityId, details = {}) {
  auditLogs.push({
    id: crypto.randomUUID(),
    actor_employee_id: actor?.employee_id || null,
    action,
    entity_type: entityType,
    entity_id: String(entityId),
    details,
    created_at: new Date().toISOString(),
  });
  saveStore(store);
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Face Attendance System',
    mode: 'node',
    face_service_configured: Boolean(FACE_PROVIDER_URL),
    face_service_mode: USE_LOCAL_FACE_PROVIDER ? 'local' : 'external',
  });
});

app.post('/api/auth/login', authRateLimit, (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Enter a valid email and password' });
  const { email, password } = parsed.data;
  const employee = employees.find((item) => item.email.toLowerCase() === String(email || '').toLowerCase());

  if (!employee || !bcrypt.compareSync(password || '', employee.passwordHash)) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }
  if (employee.active === false) {
    return res.status(403).json({ message: 'This employee account is inactive' });
  }

  const token = generateToken(employee);
  return res.json({
    access_token: token,
    token_type: 'bearer',
    employee: {
      id: employee.id,
      employee_id: employee.employee_id,
      full_name: employee.full_name,
      email: employee.email,
      department: employee.department,
      designation: employee.designation,
      office_assignment: employee.office_assignment,
      role: employee.role,
      face_status: employee.face_status,
      created_at: employee.created_at,
    },
  });
});

app.post('/api/auth/refresh', authenticate, (req, res) => {
  return res.json({ access_token: generateToken(req.employee), token_type: 'bearer' });
});

app.post('/api/auth/register', authenticate, requireAdmin, (req, res) => {
  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Invalid employee registration details',
      issues: parsed.error.issues.map(({ path, message }) => ({ field: path.join('.'), message })),
    });
  }
  const payload = parsed.data;
  const normalizedEmail = payload.email.trim();
  const employeeId = payload.employee_id.trim();

  if (employees.some((employee) =>
    employee.email.toLowerCase() === normalizedEmail.toLowerCase() ||
    String(employee.employee_id).toLowerCase() === employeeId.toLowerCase()
  )) {
    return res.status(409).json({ message: 'An employee with that email or employee ID already exists' });
  }

  const employee = {
    id: employees.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    employee_id: employeeId,
    full_name: String(payload.full_name).trim(),
    email: normalizedEmail,
    department: String(payload.department).trim(),
    designation: String(payload.designation).trim(),
    office_assignment: String(payload.office_assignment || 'Main Office').trim(),
    role: 'employee',
    active: true,
    passwordHash: bcrypt.hashSync(payload.password, 10),
    face_status: 'pending',
    face_embedding: null,
    created_at: new Date().toISOString(),
  };

  employees.push(employee);
  saveStore(store);
  writeAuditLog(req.employee, 'employee.created', 'employee', employee.employee_id);
  const token = generateToken(employee);

  return res.json({
    access_token: token,
    token_type: 'bearer',
    employee: {
      id: employee.id,
      employee_id: employee.employee_id,
      full_name: employee.full_name,
      email: employee.email,
      department: employee.department,
      designation: employee.designation,
      office_assignment: employee.office_assignment,
      role: employee.role,
      face_status: employee.face_status,
      created_at: employee.created_at,
    },
  });
});

app.get('/api/employees/me', authenticate, (req, res) => {
  const employee = req.employee;
  return res.json({
    id: employee.id,
    employee_id: employee.employee_id,
    full_name: employee.full_name,
    email: employee.email,
    department: employee.department,
    designation: employee.designation,
    office_assignment: employee.office_assignment,
    role: employee.role,
    face_status: employee.face_status,
    active: employee.active !== false,
  });
});

app.post('/api/face/enroll', authenticate, faceRateLimit, uploadLivenessVideo.single('liveness_video'), async (req, res) => {
  const employee = req.employee;
  const body = req.body || {};
  const requestedId = normalizeEmployeeId(body.employee_id) || employee.employee_id;
  const target = employees.find((item) => String(item.employee_id) === requestedId);

  if (!target) {
    return res.status(404).json({ message: 'Employee not found' });
  }
  if (!normalizeEmployeeId(target.employee_id)) {
    return res.status(500).json({
      message: `Employee record id=${target.id} is missing employee_id. Restart the backend to run the migration.`,
    });
  }
  if (target.id !== employee.id && employee.role !== 'admin') {
    return res.status(403).json({ message: 'You cannot enroll another employee' });
  }
  if (target.face_embedding) {
    return res.status(409).json({ message: 'Face enrollment already exists; administrator reset is required' });
  }

  try {
    const imageBase64 = parseImageData(body.image_base64 || '');
    if (!req.file) {
      return res.status(400).json({ message: 'A short blink/liveness video is required for enrollment' });
    }
    const providerResult = await callFaceProvider(FACE_ENROLL_PATH, {
      employee_id: target.employee_id,
      image_base64: imageBase64,
      liveness_video_base64: req.file.buffer.toString('base64'),
      liveness_video_mime_type: req.file.mimetype,
    });
    if (providerResult.liveness_passed !== true || providerResult.face_detected === false) {
      return res.status(422).json({ message: 'Face liveness check failed; please try again' });
    }
    const templateId = providerResult.template_id || providerResult.template;
    if (typeof templateId !== 'string' || !templateId) {
      return res.status(502).json({ message: 'Face service did not return an enrollment template' });
    }
    target.face_embedding = templateId;
    target.face_status = 'approved';
    saveStore(store);
    writeAuditLog(employee, 'face.enrolled', 'employee', target.employee_id);
    return res.json({ message: 'Face enrollment approved', employee_id: target.employee_id, status: target.face_status });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message || 'Face enrollment failed' });
  }
});

app.post('/api/face/verify', authenticate, faceRateLimit, uploadLivenessVideo.single('liveness_video'), async (req, res) => {
  const body = req.body || {};
  const employee = req.employee;

  if (!employee) {
    return res.status(404).json({ message: 'Employee not found' });
  }
  if (!normalizeEmployeeId(employee.employee_id)) {
    return res.status(500).json({
      message: `Your account record is missing employee_id (id=${employee.id}). Restart the backend to run the migration.`,
    });
  }
  if (!employee.face_embedding) {
    return res.status(404).json({ message: 'No approved face template found' });
  }

  try {
    const imageBase64 = parseImageData(body.image_base64 || '');
    const action = body.action;
    if (action !== 'check_in' && action !== 'check_out') {
      return res.status(400).json({ message: 'A valid attendance action is required for face verification' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'A short blink/liveness video is required for verification' });
    }
    const providerResult = await callFaceProvider(FACE_VERIFY_PATH, {
      employee_id: employee.employee_id,
      image_base64: imageBase64,
      liveness_video_base64: req.file.buffer.toString('base64'),
      liveness_video_mime_type: req.file.mimetype,
    });
    const confidence = Number(providerResult.confidence || 0);
    const livenessPassed = providerResult.liveness_passed === true;
    const recognized =
      providerResult.matched === true &&
      livenessPassed &&
      providerResult.employee_id === employee.employee_id &&
      confidence >= FACE_MATCH_THRESHOLD;

    if (!recognized) {
      return res.status(403).json({
        recognized: false,
        liveness_passed: livenessPassed,
        message: livenessPassed ? 'Face did not match the enrolled employee' : 'Blink/liveness check failed',
      });
    }

    const verification = createFaceVerificationToken(employee, action);
    return res.json({
      recognized: true,
      liveness_passed: true,
      employee_id: employee.employee_id,
      name: employee.full_name,
      confidence,
      face_verification_token: verification.token,
      verification_id: verification.verificationId,
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message || 'Face verification failed' });
  }
});

// ---------------------------------------------------------------------------
// Unified reset endpoint used by the React app.
//   scope: 'attendance'    → clear all attendance + audit logs (admin only)
//   scope: 'employee_face' → reset caller's own face (or any employee's, if admin)
//   scope: 'all'           → full wipe (admin only)
// ---------------------------------------------------------------------------
app.post('/api/admin/reset', authenticate, faceRateLimit, async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Invalid reset request',
      issues: parsed.error.issues.map(({ path, message }) => ({ field: path.join('.'), message })),
    });
  }
  const { scope } = parsed.data;
  const bodyEmployeeId = normalizeEmployeeId(parsed.data.employee_id);

  if (scope === 'attendance') {
    if (req.employee.role !== 'admin') {
      return res.status(403).json({ message: 'Administrator access is required to clear attendance data' });
    }
    attendanceRecords.splice(0, attendanceRecords.length);
    auditLogs.splice(0, auditLogs.length);
    saveStore(store);
    writeAuditLog(req.employee, 'attendance.reset_all', 'attendance', 'all');
    return res.json({ scope, message: 'Attendance records and audit logs cleared' });
  }

  if (scope === 'employee_face') {
    const targetEmployeeId = bodyEmployeeId || normalizeEmployeeId(req.employee.employee_id);
    if (!targetEmployeeId) {
      return res.status(400).json({ message: 'Employee ID is required for a per-employee face reset' });
    }
    const employee = employees.find((item) => String(item.employee_id) === targetEmployeeId);
    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    if (employee.id !== req.employee.id && req.employee.role !== 'admin') {
      return res.status(403).json({ message: 'You cannot reset another employee’s face enrollment' });
    }
    try {
      if (USE_LOCAL_FACE_PROVIDER) {
        await callFaceProvider('/reset', { scope: 'employee_face', employee_id: employee.employee_id });
      }
      employee.face_embedding = null;
      employee.face_status = 'pending';
      saveStore(store);
      writeAuditLog(req.employee, 'face.reset', 'employee', employee.employee_id);
      return res.json({ scope, employee_id: employee.employee_id, face_status: employee.face_status });
    } catch (error) {
      return res.status(error.statusCode || 502).json({ message: error.message || 'Could not reset face enrollment' });
    }
  }

  if (scope === 'all') {
    if (req.employee.role !== 'admin') {
      return res.status(403).json({ message: 'Administrator access is required for a full reset' });
    }
    if (process.env.NODE_ENV === 'production' && (!bootstrapAdminEmail || !bootstrapAdminPassword)) {
      return res.status(503).json({ message: 'Configure bootstrap administrator credentials before resetting app data' });
    }
    try {
      if (USE_LOCAL_FACE_PROVIDER) {
        await callFaceProvider('/reset', { scope: 'all' });
      } else {
        return res.status(409).json({ message: 'Full reset is unavailable with an external face provider; clear its templates first' });
      }

      employees.splice(0, employees.length);
      attendanceRecords.splice(0, attendanceRecords.length);
      auditLogs.splice(0, auditLogs.length);
      usedFaceVerificationTokens.clear();
      const admin = createBootstrapAdmin(1);
      employees.push(admin);
      saveStore(store);
      writeAuditLog(admin, 'app.reset_all', 'system', 'all');

      const { passwordHash, ...publicAdmin } = admin;
      return res.json({
        scope,
        message: 'All employee, face, attendance, and audit data has been cleared. A fresh administrator account is ready.',
        access_token: generateToken(admin),
        employee: publicAdmin,
        admin_email: bootstrapAdminEmail,
        uses_default_password: !process.env.ADMIN_PASSWORD,
      });
    } catch (error) {
      return res.status(error.statusCode || 502).json({ message: error.message || 'Could not reset app data' });
    }
  }

  return res.status(400).json({ message: 'Unknown reset scope' });
});

// Legacy alias retained for backwards compatibility.
app.post('/api/admin/reset-all-data', authenticate, requireAdmin, faceRateLimit, async (req, res) => {
  if (process.env.NODE_ENV === 'production' && (!bootstrapAdminEmail || !bootstrapAdminPassword)) {
    return res.status(503).json({ message: 'Configure bootstrap administrator credentials before resetting app data' });
  }
  try {
    if (USE_LOCAL_FACE_PROVIDER) {
      await callFaceProvider('/reset', { scope: 'all' });
    } else {
      return res.status(409).json({ message: 'Full reset is unavailable with an external face provider; clear its templates first' });
    }

    employees.splice(0, employees.length);
    attendanceRecords.splice(0, attendanceRecords.length);
    auditLogs.splice(0, auditLogs.length);
    usedFaceVerificationTokens.clear();
    const admin = createBootstrapAdmin(1);
    employees.push(admin);
    saveStore(store);

    const { passwordHash, ...publicAdmin } = admin;
    return res.json({
      message: 'All employee, face, attendance, and audit data has been cleared. A fresh administrator account is ready.',
      access_token: generateToken(admin),
      employee: publicAdmin,
      admin_email: bootstrapAdminEmail,
      uses_default_password: !process.env.ADMIN_PASSWORD,
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ message: error.message || 'Could not reset app data' });
  }
});

app.get('/api/office-locations', (req, res) => {
  return res.json([
    {
      id: 1,
      name: 'Main Office',
      latitude: OFFICE.latitude,
      longitude: OFFICE.longitude,
      radius_meters: OFFICE.radiusMeters,
      timezone: OFFICE.timezone,
    },
  ]);
});

app.get('/api/admin/office-location', authenticate, requireAdmin, (req, res) => {
  return res.json({
    latitude: OFFICE.latitude,
    longitude: OFFICE.longitude,
    radius_meters: OFFICE.radiusMeters,
    timezone: OFFICE.timezone,
  });
});

app.put('/api/admin/office-location', authenticate, requireAdmin, (req, res) => {
  const parsed = z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    radius_meters: z.number().finite().min(1).max(50000),
    timezone: z.string().min(1).max(100),
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid office location settings' });
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.timezone }).format(new Date());
  } catch {
    return res.status(400).json({ message: 'Invalid timezone' });
  }
  OFFICE.latitude = parsed.data.latitude;
  OFFICE.longitude = parsed.data.longitude;
  OFFICE.radiusMeters = parsed.data.radius_meters;
  OFFICE.timezone = parsed.data.timezone;
  attendanceRules.timezone = parsed.data.timezone;
  store.officeLocation = { ...OFFICE };
  saveStore(store);
  writeAuditLog(req.employee, 'office.location.updated', 'office-location', 'default');
  return res.json({
    latitude: OFFICE.latitude,
    longitude: OFFICE.longitude,
    radius_meters: OFFICE.radiusMeters,
    timezone: OFFICE.timezone,
  });
});

app.post('/api/attendance/process', authenticate, (req, res) => {
  const body = req.body || {};
  const employee = req.employee;
  const action = body.action;
  const faceToken = body.face_verification_token;
  let faceVerification;
  try {
    faceVerification = jwt.verify(faceToken, JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'A valid recent face verification is required' });
  }
  if (
    faceVerification.purpose !== 'attendance-face-verification' ||
    faceVerification.sub !== employee.email ||
    faceVerification.employee_id !== employee.employee_id ||
    faceVerification.action !== action ||
    !faceVerification.jti
  ) {
    return res.status(403).json({ message: 'Face verification does not match this employee or attendance action' });
  }
  if (usedFaceVerificationTokens.has(faceVerification.jti)) {
    return res.status(409).json({ message: 'This face verification has already been used' });
  }
  const parsed = attendanceSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Invalid attendance request',
      issues: parsed.error.issues.map(({ path, message }) => ({ field: path.join('.'), message })),
    });
  }
  const { location } = parsed.data;
  const bodyIdempotencyKey = parsed.data.idempotency_key;
  const headerIdempotencyKey = req.get('Idempotency-Key');
  if (bodyIdempotencyKey && headerIdempotencyKey && bodyIdempotencyKey !== headerIdempotencyKey) {
    return res.status(400).json({ message: 'Idempotency key header and body must match' });
  }
  const keyResult = z.string().uuid().safeParse(bodyIdempotencyKey || headerIdempotencyKey);
  if (!keyResult.success) {
    return res.status(400).json({ message: 'A UUID idempotency key is required in the request body or header' });
  }
  const idempotencyKey = keyResult.data;
  const duplicateRequest = attendanceRecords.some(
    (record) => record.employee_id === employee.id && record.idempotency_keys?.includes(idempotencyKey)
  );
  if (duplicateRequest) {
    return res.status(409).json({ message: 'This attendance request was already processed' });
  }
  if (location.accuracy > OFFICE.radiusMeters) {
    return res.status(400).json({ message: 'Location accuracy is insufficient; try again outdoors' });
  }
  const userDistance = haversineDistanceMeters(location.latitude, location.longitude, OFFICE.latitude, OFFICE.longitude);

  if (userDistance > OFFICE.radiusMeters) {
    return res.status(400).json({ message: 'You are outside the authorized office premises' });
  }

  if (action !== 'check_in' && action !== 'check_out') {
    return res.status(400).json({ message: 'Unsupported attendance action' });
  }

  const dateKey = officeDateKey();
  const record = attendanceRecords.find(
    (item) => item.employee_id === employee.id && item.record_date === dateKey
  ) || {
    id: attendanceRecords.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    employee_id: employee.id,
    record_date: dateKey,
    check_in: null,
    check_out: null,
    is_late: false,
    late_minutes: 0,
    working_minutes: 0,
    minimum_hours_met: false,
    location_valid: true,
    status_message: '',
    created_at: new Date().toISOString(),
  };

  record.idempotency_keys ||= [];
  if (action === 'check_in') {
    const alreadyCheckedIn = Boolean(record.check_in);
    if (alreadyCheckedIn) {
      return res.status(400).json({ message: 'You have already checked in today' });
    }

    record.check_in = new Date().toISOString();
    record.is_late = computeLateMinutes(record.check_in) > 0;
    record.late_minutes = computeLateMinutes(record.check_in);
    record.status_message = record.is_late ? 'Late arrival recorded' : 'Check-in successful';
    record.idempotency_keys.push(idempotencyKey);

    if (!attendanceRecords.some((item) => item.id === record.id)) {
      attendanceRecords.push(record);
    }
    saveStore(store);
    usedFaceVerificationTokens.add(faceVerification.jti);
    writeAuditLog(employee, 'attendance.check_in', 'attendance', record.id);

    return res.json({
      status: 'success',
      action: 'check_in',
      message: record.status_message,
      late_minutes: record.late_minutes,
      record_id: record.id,
    });
  }

  if (action === 'check_out') {
    if (!record.check_in) {
      return res.status(400).json({ message: 'You need to check in before checking out' });
    }

    if (record.check_out) {
      return res.status(400).json({ message: 'You have already checked out today' });
    }

    record.check_out = new Date().toISOString();
    const checkInDate = parseDateTime(record.check_in);
    const checkOutDate = parseDateTime(record.check_out);
    const totalMinutes = checkOutDate && checkInDate ? Math.max(0, Math.round((checkOutDate - checkInDate) / 60000)) : 0;
    record.working_minutes = totalMinutes;
    record.minimum_hours_met = totalMinutes >= attendanceRules.minimumWorkingMinutes;
    record.location_valid = true;
    record.status_message = record.minimum_hours_met ? 'Check-out successful' : 'Checkout recorded; minimum hours not met';
    record.idempotency_keys.push(idempotencyKey);

    if (!attendanceRecords.some((item) => item.id === record.id)) {
      attendanceRecords.push(record);
    }
    saveStore(store);
    usedFaceVerificationTokens.add(faceVerification.jti);
    writeAuditLog(employee, 'attendance.check_out', 'attendance', record.id);

    return res.json({
      status: 'success',
      action: 'check_out',
      message: record.status_message,
      working_minutes: totalMinutes,
      minimum_hours_met: record.minimum_hours_met,
    });
  }

  return res.status(400).json({ message: 'Unsupported attendance action' });
});

app.get('/api/attendance/today', authenticate, (req, res) => {
  const dateKey = officeDateKey();
  const record = attendanceRecords.find(
    (item) => item.employee_id === req.employee.id && item.record_date === dateKey
  );

  return res.json({
    date: dateKey,
    check_in: record?.check_in || null,
    check_out: record?.check_out || null,
    is_late: Boolean(record?.is_late),
    late_minutes: record?.late_minutes || 0,
    working_minutes: record?.working_minutes || 0,
    minimum_hours_met: Boolean(record?.minimum_hours_met),
    location_valid: Boolean(record?.location_valid),
    status_message: record?.status_message || 'No check-in recorded today',
  });
});

app.get('/api/attendance/history', authenticate, (req, res) => {
  const records = attendanceRecords
    .filter((item) => item.employee_id === req.employee.id)
    .sort((a, b) => b.record_date.localeCompare(a.record_date));

  return res.json(
    records.map((record) => ({
      employee_id: req.employee.employee_id,
      full_name: req.employee.full_name,
      date: record.record_date,
      check_in: record.check_in,
      check_out: record.check_out,
      is_late: record.is_late,
      late_minutes: record.late_minutes,
      working_minutes: record.working_minutes,
      minimum_hours_met: record.minimum_hours_met,
      location_valid: record.location_valid,
      status_message: record.status_message,
    }))
  );
});

app.get('/api/admin/overview', authenticate, requireAdmin, (req, res) => {
  const today = officeDateKey();
  const activeEmployees = employees.filter((employee) => employee.active !== false);
  const todaysRecords = attendanceRecords.filter((record) => record.record_date === today);
  const presentIds = new Set(todaysRecords.filter((record) => record.check_in).map((record) => record.employee_id));
  return res.json({
    date: today,
    total_employees: activeEmployees.length,
    present_today: presentIds.size,
    late_today: todaysRecords.filter((record) => record.check_in && record.is_late).length,
    absent_today: activeEmployees.length - presentIds.size,
    currently_checked_in: todaysRecords.filter((record) => record.check_in && !record.check_out).length,
  });
});

app.get('/api/admin/employees', authenticate, requireAdmin, (req, res) => {
  const query = String(req.query.search || '').trim().toLowerCase();
  const department = String(req.query.department || '').trim().toLowerCase();
  const result = employees
    .filter((employee) => !query || [
      employee.employee_id,
      employee.full_name,
      employee.email,
      employee.department,
    ].some((value) => String(value || '').toLowerCase().includes(query)))
    .filter((employee) => !department || String(employee.department || '').toLowerCase() === department)
    .map(({ passwordHash, face_embedding, ...employee }) => ({ ...employee, active: employee.active !== false }));
  return res.json(result);
});

app.patch('/api/admin/employees/:employeeId/status', authenticate, requireAdmin, (req, res) => {
  const parsed = z.object({ active: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'active must be true or false' });
  const employee = employees.find((item) => String(item.employee_id) === req.params.employeeId);
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  if (employee.id === req.employee.id && !parsed.data.active) {
    return res.status(400).json({ message: 'You cannot deactivate your own account' });
  }
  employee.active = parsed.data.active;
  saveStore(store);
  writeAuditLog(req.employee, parsed.data.active ? 'employee.activated' : 'employee.deactivated', 'employee', employee.employee_id);
  return res.json({ employee_id: employee.employee_id, active: employee.active });
});

app.post('/api/face/reset', authenticate, faceRateLimit, async (req, res) => {
  const employee = req.employee;
  try {
    if (USE_LOCAL_FACE_PROVIDER) {
      await callFaceProvider('/reset', { scope: 'employee_face', employee_id: employee.employee_id });
    }
    employee.face_embedding = null;
    employee.face_status = 'pending';
    saveStore(store);
    writeAuditLog(employee, 'face.reset', 'employee', employee.employee_id);
    return res.json({ employee_id: employee.employee_id, face_status: employee.face_status });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ message: error.message || 'Could not reset face enrollment' });
  }
});

app.post('/api/admin/employees/:employeeId/face-reset', authenticate, requireAdmin, async (req, res) => {
  const employee = employees.find((item) => String(item.employee_id) === req.params.employeeId);
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  try {
    if (USE_LOCAL_FACE_PROVIDER) {
      await callFaceProvider('/reset', { scope: 'employee_face', employee_id: employee.employee_id });
    }
    employee.face_embedding = null;
    employee.face_status = 'pending';
    saveStore(store);
    writeAuditLog(req.employee, 'face.reset', 'employee', employee.employee_id);
    return res.json({ employee_id: employee.employee_id, face_status: employee.face_status });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ message: error.message || 'Could not reset face enrollment' });
  }
});

app.get('/api/admin/attendance', authenticate, requireAdmin, (req, res) => {
  const { from, to, employee_id: employeeId, department } = req.query;
  const departmentEmployees = department
    ? new Set(employees.filter((employee) => employee.department === department).map((employee) => employee.id))
    : null;
  const records = attendanceRecords
    .filter((record) => !from || record.record_date >= String(from))
    .filter((record) => !to || record.record_date <= String(to))
    .filter((record) => !employeeId || String(employees.find((employee) => employee.id === record.employee_id)?.employee_id) === String(employeeId))
    .filter((record) => !departmentEmployees || departmentEmployees.has(record.employee_id))
    .sort((a, b) => b.record_date.localeCompare(a.record_date))
    .map((record) => {
      const employee = employees.find((item) => item.id === record.employee_id);
      return {
        employee_id: employee?.employee_id || '',
        full_name: employee?.full_name || '',
        department: employee?.department || '',
        date: record.record_date,
        check_in: record.check_in,
        check_out: record.check_out,
        is_late: record.is_late,
        late_minutes: record.late_minutes,
        working_minutes: record.working_minutes,
        minimum_hours_met: record.minimum_hours_met,
        location_valid: record.location_valid,
        status_message: record.status_message,
      };
    });
  return res.json(records);
});

app.get('/api/admin/attendance.csv', authenticate, requireAdmin, (req, res) => {
  const records = attendanceRecords.map((record) => {
    const employee = employees.find((item) => item.id === record.employee_id);
    return [
      employee?.employee_id || '',
      employee?.full_name || '',
      employee?.department || '',
      record.record_date,
      record.check_in || '',
      record.check_out || '',
      record.working_minutes || 0,
      record.is_late ? 'Late' : 'On time',
      record.late_minutes || 0,
      record.minimum_hours_met ? 'Met' : 'Not met',
    ];
  });
  const escapeCsv = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = [
    ['Employee ID', 'Name', 'Department', 'Date', 'Check-in', 'Check-out', 'Working minutes', 'Arrival', 'Late minutes', 'Minimum hours'].map(escapeCsv).join(','),
    ...records.map((row) => row.map(escapeCsv).join(',')),
  ].join('\r\n');
  res.type('text/csv').attachment('attendance.csv').send(csv);
});

app.get('/api/admin/attendance-rules', authenticate, requireAdmin, (req, res) => {
  return res.json(attendanceRules);
});

app.put('/api/admin/attendance-rules', authenticate, requireAdmin, (req, res) => {
  const parsed = z.object({
    checkInTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    checkOutTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    minimumWorkingMinutes: z.number().int().min(1).max(1440),
    timezone: z.string().min(1).max(100),
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid attendance rules' });
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.timezone }).format(new Date());
  } catch {
    return res.status(400).json({ message: 'Invalid timezone' });
  }
  Object.assign(attendanceRules, parsed.data);
  OFFICE.timezone = parsed.data.timezone;
  store.officeLocation = { ...OFFICE };
  saveStore(store);
  writeAuditLog(req.employee, 'attendance.rules.updated', 'attendance-rules', 'default');
  return res.json(attendanceRules);
});

app.get('/api/admin/audit-logs', authenticate, requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  return res.json(auditLogs.slice(-limit).reverse());
});

let localFaceProviderProcess = null;
if (USE_LOCAL_FACE_PROVIDER) {
  const backendDirectory = path.dirname(fileURLToPath(import.meta.url));
  const pythonExecutable = process.env.PYTHON_EXECUTABLE || (
    process.platform === 'win32'
      ? path.join(backendDirectory, '.venv', 'Scripts', 'python.exe')
      : path.join(backendDirectory, '.venv', 'bin', 'python')
  );
  localFaceProviderProcess = spawn(
    existsSync(pythonExecutable) ? pythonExecutable : 'python3',
    [path.join(backendDirectory, 'local_face_provider.py')],
    { cwd: backendDirectory, stdio: 'inherit', env: process.env }
  );
  localFaceProviderProcess.on('error', (error) => console.error(`Could not start local face provider: ${error.message}`));
  localFaceProviderProcess.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`Local face provider exited with code ${code}`);
  });
  process.on('exit', () => localFaceProviderProcess?.kill());
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FRS backend listening on port ${PORT}`);
});