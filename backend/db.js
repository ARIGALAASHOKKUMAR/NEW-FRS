import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(directory, 'data');
const defaultDatabaseFile = path.join(dataDirectory, 'attendance.json');

export function loadStore() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const databaseFile = process.env.FRS_DATABASE_FILE || defaultDatabaseFile;

  if (!fs.existsSync(databaseFile)) {
    return { employees: [], attendanceRecords: [], auditLogs: [], attendanceRules: null, officeLocation: null };
  }

  const contents = fs.readFileSync(databaseFile, 'utf8');
  const store = JSON.parse(contents);
  return {
    employees: Array.isArray(store.employees) ? store.employees : [],
    attendanceRecords: Array.isArray(store.attendanceRecords) ? store.attendanceRecords : [],
    auditLogs: Array.isArray(store.auditLogs) ? store.auditLogs : [],
    attendanceRules: store.attendanceRules && typeof store.attendanceRules === 'object' ? store.attendanceRules : null,
    officeLocation: store.officeLocation && typeof store.officeLocation === 'object' ? store.officeLocation : null,
  };
}

export function saveStore(store) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const databaseFile = process.env.FRS_DATABASE_FILE || defaultDatabaseFile;
  const temporaryFile = `${databaseFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, databaseFile);
}
