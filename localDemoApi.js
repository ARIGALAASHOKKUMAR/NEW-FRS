import Storage from 'expo-sqlite/kv-store';
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = 'frs.offline-demo.v1';
const DEFAULT_ADMIN_EMAIL = 'admin@attendance.local';
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const DEFAULT_OFFICE = {
  id: 1,
  name: 'Main Office',
  latitude: 16.422708,
  longitude: 80.560739,
  radius_meters: 100,
  timezone: 'Asia/Kolkata',
};
const DEFAULT_RULES = {
  checkInTime: '10:30',
  checkOutTime: '18:30',
  minimumWorkingMinutes: 480,
  timezone: DEFAULT_OFFICE.timezone,
};
const passwordKey = (employeeId) => `frs.demo.password.${employeeId}`;

let statePromise;
let writeQueue = Promise.resolve();

function createDefaultAdmin() {
  return {
    id: 1,
    employee_id: 'EMP-1001',
    full_name: 'System Administrator',
    email: DEFAULT_ADMIN_EMAIL,
    department: 'Operations',
    designation: 'Engineer',
    office_assignment: 'Main Office',
    role: 'admin',
    active: true,
    face_status: 'pending',
    created_at: new Date().toISOString(),
  };
}

function createDefaultState() {
  return {
    employees: [createDefaultAdmin()],
    attendanceRecords: [],
    auditLogs: [],
    officeLocation: { ...DEFAULT_OFFICE },
    attendanceRules: { ...DEFAULT_RULES },
  };
}

async function loadState() {
  if (!statePromise) {
    statePromise = (async () => {
      const saved = await Storage.getItem(STORAGE_KEY);
      const state = saved ? JSON.parse(saved) : createDefaultState();
      let migrated = !saved;
      for (const employee of state.employees) {
        const key = passwordKey(employee.id);
        if (employee.password) {
          if (!await SecureStore.getItemAsync(key)) await SecureStore.setItemAsync(key, employee.password);
          delete employee.password;
          migrated = true;
        } else if (!await SecureStore.getItemAsync(key) && employee.id === 1 && employee.role === 'admin') {
          await SecureStore.setItemAsync(key, DEFAULT_ADMIN_PASSWORD);
        }
      }
      if (migrated) await Storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return state;
    })();
  }
  return statePromise;
}

function updateState(updater) {
  const operation = writeQueue.then(async () => {
    const state = await loadState();
    const result = await updater(state);
    await Storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function apiError(message, status = 400) {
  const error = new Error(message);
  error.response = { status, data: { message } };
  return error;
}

function publicEmployee(employee) {
  const { password, ...result } = employee;
  return result;
}

function getToken(config) {
  const headers = config?.headers;
  const authorization = headers?.Authorization || headers?.authorization || headers?.get?.('Authorization') || '';
  return String(authorization).replace(/^Bearer\s+/i, '');
}

function requireEmployee(state, config) {
  const token = getToken(config);
  const match = /^demo-token-(\d+)$/.exec(token);
  const employee = match ? state.employees.find((item) => item.id === Number(match[1])) : null;
  if (!employee || employee.active === false) throw apiError('Demo session expired. Sign in again.', 401);
  return employee;
}

function dateKey(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function distanceMeters(firstLatitude, firstLongitude, secondLatitude, secondLongitude) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const deltaLatitude = toRadians(secondLatitude - firstLatitude);
  const deltaLongitude = toRadians(secondLongitude - firstLongitude);
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(toRadians(firstLatitude)) * Math.cos(toRadians(secondLatitude))
    * Math.sin(deltaLongitude / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function todayRecord(state, employee) {
  const today = dateKey(state.officeLocation.timezone);
  return state.attendanceRecords.find((record) => record.employee_id === employee.id && record.record_date === today);
}

export async function localDemoRequest(method, path, body, config = {}) {
  return updateState(async (state) => {
    if (method === 'POST' && path === '/api/auth/login') {
      const employee = state.employees.find((item) => item.email.toLowerCase() === String(body?.email || '').toLowerCase());
      if (!employee || await SecureStore.getItemAsync(passwordKey(employee.id)) !== body?.password) {
        throw apiError('Invalid email or password', 401);
      }
      if (employee.active === false) throw apiError('This employee account is inactive', 403);
      return {
        access_token: `demo-token-${employee.id}`,
        token_type: 'bearer',
        employee: publicEmployee(employee),
      };
    }

    if (method === 'GET' && path === '/api/health') {
      return { status: 'ok', service: 'Face Attendance System', mode: 'offline-demo', face_service_configured: true, face_service_mode: 'simulated' };
    }

    if (method === 'GET' && path === '/api/office-locations') return [state.officeLocation];

    const employee = requireEmployee(state, config);

    if (method === 'GET' && path === '/api/employees/me') return publicEmployee(employee);

    if (method === 'GET' && path === '/api/attendance/today') {
      const record = todayRecord(state, employee);
      return {
        date: dateKey(state.officeLocation.timezone),
        check_in: record?.check_in || null,
        check_out: record?.check_out || null,
        is_late: Boolean(record?.is_late),
        late_minutes: record?.late_minutes || 0,
        working_minutes: record?.working_minutes || 0,
        minimum_hours_met: Boolean(record?.minimum_hours_met),
        location_valid: record?.location_valid ?? false,
        status_message: record?.status_message || 'No check-in recorded today',
      };
    }

    if (method === 'GET' && path === '/api/attendance/history') {
      return state.attendanceRecords
        .filter((record) => record.employee_id === employee.id)
        .sort((first, second) => second.record_date.localeCompare(first.record_date))
        .map((record) => ({
          employee_id: employee.employee_id,
          full_name: employee.full_name,
          date: record.record_date,
          check_in: record.check_in,
          check_out: record.check_out,
          is_late: record.is_late,
          late_minutes: record.late_minutes,
          working_minutes: record.working_minutes,
          minimum_hours_met: record.minimum_hours_met,
          location_valid: record.location_valid,
          status_message: record.status_message,
        }));
    }

    if (method === 'POST' && path === '/api/auth/register') {
      if (employee.role !== 'admin') throw apiError('Administrator access is required', 403);
      if (state.employees.some((item) => item.email.toLowerCase() === body.email.toLowerCase())) {
        throw apiError('An employee with this email already exists', 409);
      }
      if (state.employees.some((item) => item.employee_id === body.employee_id)) {
        throw apiError('An employee with this ID already exists', 409);
      }
      if (String(body.password || '').length < 8) throw apiError('Password must be at least 8 characters', 400);
      const created = {
        id: state.employees.reduce((max, item) => Math.max(max, item.id), 0) + 1,
        employee_id: body.employee_id,
        full_name: body.full_name,
        email: body.email,
        department: body.department,
        designation: body.designation,
        office_assignment: body.office_assignment || 'Main Office',
        role: 'employee',
        active: true,
        face_status: 'pending',
        created_at: new Date().toISOString(),
      };
      await SecureStore.setItemAsync(passwordKey(created.id), body.password);
      state.employees.push(created);
      return { employee: publicEmployee(created) };
    }

    if (method === 'POST' && path === '/api/face/enroll') {
      employee.face_status = 'approved';
      return { message: 'Demo face enrollment complete', employee_id: employee.employee_id, status: employee.face_status };
    }

    if (method === 'POST' && path === '/api/face/verify') {
      if (employee.face_status !== 'approved') throw apiError('Enroll a face before checking in or out', 409);
      return {
        recognized: true,
        liveness_passed: true,
        employee_id: employee.employee_id,
        confidence: 1,
        face_verification_token: `demo-face-${Date.now()}`,
      };
    }

    if (method === 'POST' && path === '/api/face/reset') {
      employee.face_status = 'pending';
      return { employee_id: employee.employee_id, face_status: employee.face_status };
    }

    if (method === 'POST' && path === '/api/attendance/process') {
      if (body.action !== 'check_in' && body.action !== 'check_out') throw apiError('Unsupported attendance action', 400);
      if (!String(body.face_verification_token || '').startsWith('demo-face-')) throw apiError('Complete the demo face check first', 403);
      const { latitude, longitude, accuracy } = body.location || {};
      if (![latitude, longitude, accuracy].every(Number.isFinite)) throw apiError('Valid demo location is required', 400);
      const office = state.officeLocation;
      if (accuracy > office.radius_meters || distanceMeters(latitude, longitude, office.latitude, office.longitude) > office.radius_meters) {
        throw apiError('You are outside the authorized office premises', 400);
      }

      const today = dateKey(office.timezone);
      let record = todayRecord(state, employee);
      if (!record) {
        record = {
          id: state.attendanceRecords.reduce((max, item) => Math.max(max, item.id), 0) + 1,
          employee_id: employee.id,
          record_date: today,
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
        state.attendanceRecords.push(record);
      }

      if (body.action === 'check_in') {
        if (record.check_in) throw apiError('You have already checked in today', 400);
        record.check_in = new Date().toISOString();
        record.status_message = 'DEMO check-in recorded; face verification was simulated';
        return { status: 'success', action: 'check_in', message: record.status_message, late_minutes: 0, record_id: record.id };
      }

      if (!record.check_in) throw apiError('You need to check in before checking out', 400);
      if (record.check_out) throw apiError('You have already checked out today', 400);
      record.check_out = new Date().toISOString();
      record.working_minutes = Math.max(0, Math.round((new Date(record.check_out) - new Date(record.check_in)) / 60000));
      record.minimum_hours_met = record.working_minutes >= state.attendanceRules.minimumWorkingMinutes;
      record.status_message = 'DEMO check-out recorded; face verification was simulated';
      return { status: 'success', action: 'check_out', message: record.status_message, working_minutes: record.working_minutes, minimum_hours_met: record.minimum_hours_met };
    }

    if (method === 'POST' && path === '/api/admin/reset-all-data') {
      if (employee.role !== 'admin') throw apiError('Administrator access is required', 403);
      await Promise.all(state.employees.map((item) => SecureStore.deleteItemAsync(passwordKey(item.id))));
      state.employees = [createDefaultAdmin()];
      state.attendanceRecords = [];
      state.auditLogs = [];
      await SecureStore.setItemAsync(passwordKey(1), DEFAULT_ADMIN_PASSWORD);
      return {
        message: 'All offline demo data has been cleared. Face checks remain simulated.',
        access_token: 'demo-token-1',
        employee: publicEmployee(state.employees[0]),
        admin_email: DEFAULT_ADMIN_EMAIL,
        uses_default_password: true,
      };
    }

    if (method === 'GET' && path === '/api/admin/office-location') {
      if (employee.role !== 'admin') throw apiError('Administrator access is required', 403);
      return state.officeLocation;
    }

    throw apiError(`Offline demo does not implement ${method} ${path}`, 404);
  });
}