import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { Camera, CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { NavigationContainer, useFocusEffect } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { create as createAxios } from 'axios';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';

const Stack = createStackNavigator();

const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ||
  (() => {
    if (Platform.OS === 'web') {
      return `http://${globalThis.location?.hostname || 'localhost'}:5001`;
    }
    if (Platform.OS === 'android' && Constants.isDevice === false) {
      return 'http://10.0.2.2:5001';
    }
    const hostUri = Constants.expoConfig?.hostUri;
    const host = hostUri ? new URL(`http://${hostUri}`).hostname : null;
    return `http://${host || '127.0.0.1'}:5001`;
  })();

const api = createAxios({
  baseURL: API_BASE_URL,
  timeout: 15000,
});

async function saveSession(token, employee) {
  await SecureStore.setItemAsync('token', token);
  await SecureStore.setItemAsync('employee', JSON.stringify(employee));
}

async function clearSession() {
  await SecureStore.deleteItemAsync('token');
  await SecureStore.deleteItemAsync('employee');
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Card({ title, children, style }) {
  return (
    <View style={[styles.card, style]}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function getApiErrorMessage(error) {
  if (error.response?.data?.message) return error.response.data.message;
  if (error.response?.data?.detail) return error.response.data.detail;
  if (error.response?.data?.issues?.length) {
    return error.response.data.issues
      .map((issue) => `${issue.field}: ${issue.message}`)
      .join('\n');
  }
  if (error.request) {
    return `Cannot reach the backend at ${API_BASE_URL}. Check that the server is running and the device can reach this address.`;
  }
  return error.message || 'The request failed.';
}

// ---------------------------------------------------------------------------
// Shared authenticated helpers (used by Reset screen and elsewhere)
// ---------------------------------------------------------------------------

async function authHeaders() {
  const token = await SecureStore.getItemAsync('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function resetAttendance() {
  return api.post('/api/admin/reset', { scope: 'attendance' }, { headers: await authHeaders() });
}

async function resetMyFace(employeeId) {
  if (!employeeId) throw new Error('Missing employee_id for face reset');
  return api.post(
    '/api/admin/reset',
    { scope: 'employee_face', employee_id: String(employeeId) },
    { headers: await authHeaders() }
  );
}

async function resetAllData() {
  return api.post('/api/admin/reset', { scope: 'all' }, { headers: await authHeaders() });
}

// ---------------------------------------------------------------------------

function SplashScreen({ navigation }) {
  useEffect(() => {
    const timer = setTimeout(() => navigation.replace('Login'), 1200);
    return () => clearTimeout(timer);
  }, [navigation]);

  return (
    <SafeAreaView style={styles.centeredScreen}>
      <StatusBar style="light" />
      <View style={styles.heroBadge}>
        <Text style={styles.logoText}>FRS</Text>
      </View>
      <Text style={styles.title}>Face Attendance</Text>
      <Text style={styles.subtitle}>Employee recognition and attendance system</Text>
    </SafeAreaView>
  );
}

function LoginScreen({ setAuthenticatedUser }) {
  const [email, setEmail] = useState('admin@attendance.local');
  const [password, setPassword] = useState('admin123');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    try {
      const response = await api.post('/api/auth/login', { email, password });
      const { access_token, employee } = response.data;
      await saveSession(access_token, employee);
      setAuthenticatedUser(employee);
    } catch (error) {
      Alert.alert('Login failed', getApiErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.screenContainer}>
      <StatusBar style="dark" />
      <Text style={styles.pageHeading}>Welcome back</Text>
      <Text style={styles.subText}>Sign in to access attendance and verification.</Text>

      <View style={styles.inputCard}>
        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <Pressable style={styles.primaryButton} onPress={handleLogin} disabled={loading}>
          <Text style={styles.primaryButtonText}>{loading ? 'Signing in...' : 'Log in'}</Text>
        </Pressable>
      </View>

      <Card title="Demo credentials">
        <Text style={styles.mutedText}>Email: admin@attendance.local</Text>
        <Text style={styles.mutedText}>Password: admin123</Text>
      </Card>
    </SafeAreaView>
  );
}

function DashboardScreen({ user, navigation, logout }) {
  const [loading, setLoading] = useState(true);
  const [todayRecord, setTodayRecord] = useState({ check_in: null, check_out: null, working_minutes: 0, status_message: 'No attendance recorded yet.' });

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    const loadToday = async () => {
      try {
        const response = await api.get('/api/attendance/today', { headers: await authHeaders() });
        if (active) setTodayRecord(response.data);
      } catch (error) {
        if (active) Alert.alert('Attendance unavailable', getApiErrorMessage(error));
      } finally {
        if (active) setLoading(false);
      }
    };
    loadToday();
    return () => { active = false; };
  }, []));

  const startAttendance = (action) => {
    if (loading) return;
    if (action === 'check_in' && todayRecord.check_in) {
      Alert.alert('Already checked in', 'Only one check-in is allowed per day.');
      return;
    }
    if (action === 'check_out' && !todayRecord.check_in) {
      Alert.alert('Check-in required', 'Check in before checking out.');
      return;
    }
    if (action === 'check_out' && todayRecord.check_out) {
      Alert.alert('Already checked out', 'Only one check-out is allowed per day.');
      return;
    }
    navigation.navigate('AttendanceCapture', { action });
  };

  const confirmLogout = () => {
    Alert.alert('Log out?', 'You will need to sign in again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => logout?.() },
    ]);
  };

  return (
    <SafeAreaView style={styles.screenContainer}>
      <ScrollView contentContainerStyle={styles.contentSpacer}>
        <Text style={styles.pageHeading}>{user.full_name}</Text>
        <Text style={styles.subText}>Employee ID: {user.employee_id}</Text>
        <Card title="Today">
          <Text style={styles.statLabel}>Check-in</Text>
          <Text style={styles.statValue}>{formatTime(todayRecord.check_in)}</Text>
          <Text style={styles.statLabel}>Check-out</Text>
          <Text style={styles.statValue}>{formatTime(todayRecord.check_out)}</Text>
          <Text style={styles.statLabel}>Working duration</Text>
          <Text style={styles.statValue}>{todayRecord.working_minutes || 0} min</Text>
          <Text style={styles.statLabel}>Status</Text>
          <Text style={styles.statValue}>{loading ? 'Loading attendance…' : todayRecord.status_message}</Text>
        </Card>
        <View style={styles.actionRow}>
          <Pressable style={[styles.primaryButtonLarge, (loading || Boolean(todayRecord.check_in)) && styles.disabledButton]} onPress={() => startAttendance('check_in')} disabled={loading || Boolean(todayRecord.check_in)}>
            <Text style={styles.primaryButtonText}>Check In</Text>
          </Pressable>
          <Pressable style={[styles.secondaryButtonLarge, (loading || !todayRecord.check_in || Boolean(todayRecord.check_out)) && styles.disabledButton]} onPress={() => startAttendance('check_out')} disabled={loading || !todayRecord.check_in || Boolean(todayRecord.check_out)}>
            <Text style={styles.secondaryButtonText}>Check Out</Text>
          </Pressable>
        </View>
        <Pressable style={styles.linkButton} onPress={() => navigation.navigate('FaceEnrollment')}><Text style={styles.linkButtonText}>First-time enrollment</Text></Pressable>
        <Pressable style={styles.linkButton} onPress={() => navigation.navigate('History')}><Text style={styles.linkButtonText}>Attendance history</Text></Pressable>
        <Pressable style={styles.linkButton} onPress={() => navigation.navigate('Profile')}><Text style={styles.linkButtonText}>Profile</Text></Pressable>
        <Pressable style={styles.linkButton} onPress={() => navigation.navigate('Permissions')}><Text style={styles.linkButtonText}>Permissions and office location</Text></Pressable>
        <Pressable style={styles.linkButton} onPress={() => navigation.navigate('ResetData')}><Text style={styles.linkButtonText}>Reset captured data</Text></Pressable>
        {user.role === 'admin' ? (
          <Pressable style={styles.linkButton} onPress={() => navigation.navigate('EmployeeRegistration')}>
            <Text style={styles.linkButtonText}>Create employee account</Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.dangerButton} onPress={confirmLogout}>
          <Text style={styles.dangerButtonText}>Log out</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function ResetDataScreen({ user, logout }) {
  const [busy, setBusy] = useState(false);

  const confirmAndRun = (title, message, runner) => {
    if (busy) return;
    Alert.alert(
      `Reset ${title}?`,
      message || 'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              const response = await runner();
              Alert.alert('Done', response?.data?.message || `${title} was reset.`);
            } catch (error) {
              Alert.alert('Reset failed', getApiErrorMessage(error));
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const resetLocalSession = async () => {
    Alert.alert(
      'Clear local session?',
      'You will need to log in again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await clearSession();
            logout?.();
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.screenContainer}>
      <ScrollView contentContainerStyle={styles.contentSpacer}>
        <Text style={styles.pageHeading}>Reset captured data</Text>
        <Text style={styles.subText}>Choose what to clear. Resets are permanent.</Text>

        <Card title="Attendance">
          <Text style={styles.mutedText}>
            Deletes all check-in/check-out records and audit logs.
          </Text>
          <Pressable
            style={[styles.primaryButton, busy && styles.disabledButton]}
            onPress={() =>
              confirmAndRun(
                'attendance data',
                'All attendance records will be deleted.',
                resetAttendance
              )
            }
            disabled={busy}
          >
            <Text style={styles.primaryButtonText}>{busy ? 'Resetting…' : 'Reset attendance data'}</Text>
          </Pressable>
        </Card>

        <Card title="My face enrollment">
          <Text style={styles.mutedText}>
            Sets your face status to pending so you can re-enroll.
          </Text>
          <Pressable
            style={[styles.secondaryButton, busy && styles.disabledButton]}
            onPress={() =>
              confirmAndRun(
                'my face enrollment',
                'Your face template will be deleted and you will need to re-enroll.',
                () => resetMyFace(user.employee_id)
              )
            }
            disabled={busy}
          >
            <Text style={styles.secondaryButtonText}>Reset my face enrollment</Text>
          </Pressable>
        </Card>

        {user.role === 'admin' ? (
          <Card title="Everything (admin)">
            <Text style={styles.mutedText}>
              Clears all attendance and face templates, then recreates a fresh bootstrap admin.
            </Text>
            <Pressable
              style={[styles.dangerButton, busy && styles.disabledButton]}
              onPress={() =>
                confirmAndRun(
                  'all data',
                  'All employees, attendance, and face templates will be deleted. A fresh admin account will be created.',
                  async () => {
                    const response = await resetAllData();
                    // If the backend rotates the admin token, update the local session.
                    if (response?.data?.access_token && response?.data?.employee) {
                      await saveSession(response.data.access_token, response.data.employee);
                      logout?.();
                    }
                    return response;
                  }
                )
              }
              disabled={busy}
            >
              <Text style={styles.dangerButtonText}>Reset all data</Text>
            </Pressable>
          </Card>
        ) : null}

        <Card title="Local session">
          <Text style={styles.mutedText}>
            Clears your saved token on this device. You will need to log in again.
          </Text>
          <Pressable style={styles.linkButton} onPress={resetLocalSession}>
            <Text style={styles.linkButtonText}>Clear local session</Text>
          </Pressable>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeLivenessFormData(imageBase64, videoUri, fields = {}) {
  const formData = new FormData();
  formData.append('image_base64', `data:image/jpeg;base64,${imageBase64}`);
  Object.entries(fields).forEach(([key, value]) => formData.append(key, String(value)));
  formData.append('liveness_video', {
    uri: videoUri,
    name: Platform.OS === 'ios' ? 'blink-challenge.mov' : 'blink-challenge.mp4',
    type: Platform.OS === 'ios' ? 'video/quicktime' : 'video/mp4',
  });
  return formData;
}

function useLivenessCameraMode() {
  const [cameraMode, setCameraMode] = useState('picture');
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const cameraModeRef = useRef('picture');
  const cameraReadyRef = useRef(false);
  const cameraReadyWaiters = useRef([]);

  const handleCameraReady = () => {
    cameraReadyRef.current = true;
    setCameraError('');
    setCameraReady(true);
    cameraReadyWaiters.current.splice(0).forEach(({ resolve, timeout }) => {
      clearTimeout(timeout);
      resolve();
    });
  };

  const handleCameraMountError = ({ nativeEvent }) => {
    const message = nativeEvent?.message || 'The camera could not be started.';
    setCameraError(message);
    cameraReadyWaiters.current.splice(0).forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error(message));
    });
  };

  const switchCameraMode = (mode) => {
    if (cameraModeRef.current === mode && cameraReadyRef.current) return Promise.resolve();

    cameraModeRef.current = mode;
    cameraReadyRef.current = false;
    setCameraReady(false);
    setCameraError('');

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          cameraReadyWaiters.current = cameraReadyWaiters.current.filter((item) => item !== waiter);
          reject(new Error('Camera did not become ready for video recording. Close other camera apps and try again.'));
        }, 10000),
      };
      cameraReadyWaiters.current.push(waiter);
      setCameraMode(mode);
    });
  };

  return {
    cameraMode,
    cameraReady,
    cameraError,
    handleCameraReady,
    handleCameraMountError,
    switchCameraMode,
  };
}

async function recordBlinkChallenge(cameraRef, switchCameraMode) {
  if (Platform.OS === 'web') throw new Error('Blink/liveness recording requires Expo Go on an iOS or Android device.');
  if (!cameraRef.current?.recordAsync || !cameraRef.current?.stopRecording) {
    throw new Error('This camera does not support liveness video recording.');
  }

  await switchCameraMode('video');
  try {
    const recordingPromise = cameraRef.current.recordAsync({
      maxDuration: 8,
      maxFileSize: 12 * 1024 * 1024,
    }).then(
      (recording) => ({ recording }),
      (error) => ({ error })
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
    cameraRef.current?.stopRecording();
    const result = await recordingPromise;
    if (result.error) throw result.error;
    if (!result.recording?.uri) throw new Error('The camera stopped before producing a video. Please try again.');
    return result.recording.uri;
  } finally {
    await switchCameraMode('picture');
  }
}

function createIdempotencyKey() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function FaceEnrollmentScreen({ user }) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const [processing, setProcessing] = useState(false);
  const [recording, setRecording] = useState(false);
  const {
    cameraMode,
    cameraReady,
    cameraError,
    handleCameraReady,
    handleCameraMountError,
    switchCameraMode,
  } = useLivenessCameraMode();
  const [complete, setComplete] = useState(user.face_status === 'approved');

  useEffect(() => { if (!permission) requestPermission(); }, [permission, requestPermission]);

  const enrollFace = async () => {
    if (!cameraReady || processing || recording) return;
    setProcessing(true);
    setRecording(true);
    try {
      const videoUri = await recordBlinkChallenge(cameraRef, switchCameraMode);
      setRecording(false);
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7, base64: true });
      if (!photo.base64) throw new Error('Could not capture a face image.');
      await api.post(
        '/api/face/enroll',
        makeLivenessFormData(photo.base64, videoUri, { employee_id: user.employee_id }),
        { headers: await authHeaders() }
      );
      setComplete(true);
      Alert.alert('Enrollment complete', 'The backend provider approved your blink challenge and face enrollment.');
    } catch (error) {
      Alert.alert('Enrollment failed', getApiErrorMessage(error));
    } finally {
      setRecording(false);
      setProcessing(false);
    }
  };

  if (!permission?.granted) {
    return <SafeAreaView style={styles.screenContainer}><Text style={styles.pageHeading}>Camera access required</Text><Text style={styles.subText}>Enable camera permission to complete face enrollment.</Text><Pressable style={styles.primaryButton} onPress={requestPermission}><Text style={styles.primaryButtonText}>Allow camera</Text></Pressable></SafeAreaView>;
  }
  if (complete) {
    return <SafeAreaView style={styles.screenContainer}><Text style={styles.pageHeading}>Face already enrolled</Text><Text style={styles.subText}>Contact an administrator if you need to reset your face enrollment.</Text></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.screenContainer}>
      <Text style={styles.pageHeading}>Face enrollment</Text>
      <Text style={styles.subText}>Look at the camera and blink once during the 5-second recording. Your backend face service checks liveness and creates the face template.</Text>
      {cameraError ? <Text style={styles.errorText}>{cameraError}</Text> : null}
      <CameraView key={cameraMode} style={styles.cameraPreview} ref={cameraRef} facing="front" mode={cameraMode} mute onCameraReady={handleCameraReady} onMountError={handleCameraMountError} />
      <Pressable style={styles.primaryButton} onPress={enrollFace} disabled={!cameraReady || processing || recording}>
        <Text style={styles.primaryButtonText}>{recording ? 'Blink once now…' : processing ? 'Enrolling…' : 'Start blink check and enroll'}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

function FaceVerificationScreen({ route, navigation }) {
  const action = route?.params?.action || 'check_in';
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const [processing, setProcessing] = useState(false);
  const [recording, setRecording] = useState(false);
  const {
    cameraMode,
    cameraReady,
    cameraError,
    handleCameraReady,
    handleCameraMountError,
    switchCameraMode,
  } = useLivenessCameraMode();

  useEffect(() => { if (!permission) requestPermission(); }, [permission, requestPermission]);

  const verifyAndSubmit = async () => {
    if (!cameraReady || processing || recording) return;
    setProcessing(true);
    setRecording(true);
    try {
      const videoUri = await recordBlinkChallenge(cameraRef, switchCameraMode);
      setRecording(false);
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7, base64: true });
      if (!photo.base64) throw new Error('Could not capture a face image.');
      const faceResponse = await api.post(
        '/api/face/verify',
        makeLivenessFormData(photo.base64, videoUri, { action }),
        { headers: await authHeaders() }
      );
      if (!faceResponse.data.recognized || !faceResponse.data.liveness_passed || !faceResponse.data.face_verification_token) {
        throw new Error(faceResponse.data.message || 'Face or blink verification failed.');
      }
      const permissionResult = await Location.requestForegroundPermissionsAsync();
      if (permissionResult.status !== 'granted') throw new Error('Location permission is required for attendance.');
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const idempotencyKey = createIdempotencyKey();
      const result = await api.post('/api/attendance/process', {
        action,
        face_verification_token: faceResponse.data.face_verification_token,
        idempotency_key: idempotencyKey,
        location: { latitude: location.coords.latitude, longitude: location.coords.longitude, accuracy: location.coords.accuracy },
      }, { headers: await authHeaders() });
      Alert.alert('Attendance updated', result.data.message || 'Attendance recorded.');
      navigation.goBack();
    } catch (error) {
      Alert.alert('Attendance failed', getApiErrorMessage(error));
    } finally {
      setRecording(false);
      setProcessing(false);
    }
  };

  if (!permission?.granted) {
    return <SafeAreaView style={styles.screenContainer}><Text style={styles.pageHeading}>Camera access required</Text><Text style={styles.subText}>Enable camera permission to verify your face.</Text><Pressable style={styles.primaryButton} onPress={requestPermission}><Text style={styles.primaryButtonText}>Enable camera</Text></Pressable></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.screenContainer}>
      <Text style={styles.pageHeading}>{action === 'check_in' ? 'Check-in verification' : 'Check-out verification'}</Text>
      <Text style={styles.subText}>Blink once during the 5-second video. The backend verifies the video and face against your enrollment before recording attendance.</Text>
      {cameraError ? <Text style={styles.errorText}>{cameraError}</Text> : null}
      <CameraView key={cameraMode} style={styles.cameraPreview} ref={cameraRef} facing="front" mode={cameraMode} mute onCameraReady={handleCameraReady} onMountError={handleCameraMountError} />
      <Pressable style={styles.primaryButton} onPress={verifyAndSubmit} disabled={!cameraReady || processing || recording}>
        <Text style={styles.primaryButtonText}>{recording ? 'Blink once now…' : processing ? 'Verifying face and location…' : 'Start blink check'}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

function AttendanceHistoryScreen() {
  const [records, setRecords] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const loadHistory = async () => {
      try {
        const response = await api.get('/api/attendance/history', { headers: await authHeaders() });
        setRecords(response.data || []);
      } catch (error) {
        setErrorMessage(getApiErrorMessage(error));
      }
    };
    loadHistory();
  }, []);

  return (
    <SafeAreaView style={styles.screenContainer}>
      <Text style={styles.pageHeading}>Attendance history</Text>
      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      <ScrollView contentContainerStyle={styles.listSpacing}>
        {records.map((record, index) => (
          <Card key={`${record.date}-${index}`} title={record.date} style={styles.historyCard}>
            <Text style={styles.mutedText}>Check-in: {formatTime(record.check_in)}</Text>
            <Text style={styles.mutedText}>Check-out: {formatTime(record.check_out)}</Text>
            <Text style={styles.mutedText}>Late: {record.is_late ? `${record.late_minutes} min` : 'On time'}</Text>
            <Text style={styles.mutedText}>Working: {record.working_minutes} min</Text>
            <Text style={styles.mutedText}>Minimum hours: {record.minimum_hours_met ? 'Met' : 'Not met'}</Text>
            <Text style={styles.mutedText}>Location validation: {record.location_valid ? 'Passed' : 'Failed'}</Text>
          </Card>
        ))}
        {!errorMessage && records.length === 0 ? (
          <Text style={styles.mutedText}>No attendance records yet.</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function EmployeeRegistrationScreen() {
  const [form, setForm] = useState({
    employee_id: '',
    full_name: '',
    email: '',
    password: '',
    department: '',
    designation: '',
    office_assignment: 'Main Office',
  });
  const [saving, setSaving] = useState(false);

  const updateField = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const createEmployee = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await api.post('/api/auth/register', form, { headers: await authHeaders() });
      Alert.alert('Employee created', `${response.data.employee.full_name} can now sign in and enroll their face.`);
      setForm({
        employee_id: '',
        full_name: '',
        email: '',
        password: '',
        department: '',
        designation: '',
        office_assignment: 'Main Office',
      });
    } catch (error) {
      Alert.alert('Could not create employee', getApiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const fields = [
    ['employee_id', 'Employee ID'],
    ['full_name', 'Full name'],
    ['email', 'Email address'],
    ['password', 'Initial password (8+ characters)'],
    ['department', 'Department'],
    ['designation', 'Designation'],
    ['office_assignment', 'Office assignment'],
  ];

  return (
    <SafeAreaView style={styles.screenContainer}>
      <ScrollView contentContainerStyle={styles.contentSpacer}>
        <Text style={styles.pageHeading}>Create employee</Text>
        <Text style={styles.subText}>New accounts are created as employees and must enroll a face before attendance.</Text>
        <View style={styles.inputCard}>
          {fields.map(([field, label]) => (
            <View key={field}>
              <Text style={styles.label}>{label}</Text>
              <TextInput
                style={styles.input}
                value={form[field]}
                onChangeText={(value) => updateField(field, value)}
                autoCapitalize={field === 'email' ? 'none' : 'words'}
                keyboardType={field === 'email' ? 'email-address' : 'default'}
                secureTextEntry={field === 'password'}
              />
            </View>
          ))}
          <Pressable style={styles.primaryButton} onPress={createEmployee} disabled={saving}>
            <Text style={styles.primaryButtonText}>{saving ? 'Creating…' : 'Create employee account'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ProfileScreen({ user }) {
  return (
    <SafeAreaView style={styles.screenContainer}>
      <Text style={styles.pageHeading}>Profile</Text>
      <Card title="Employee details">
        <Text style={styles.mutedText}>Name: {user.full_name}</Text>
        <Text style={styles.mutedText}>Employee ID: {user.employee_id}</Text>
        <Text style={styles.mutedText}>Department: {user.department}</Text>
        <Text style={styles.mutedText}>Designation: {user.designation}</Text>
        <Text style={styles.mutedText}>Office assignment: {user.office_assignment}</Text>
        <Text style={styles.mutedText}>Face status: {user.face_status}</Text>
      </Card>
    </SafeAreaView>
  );
}

function PermissionScreen() {
  const [cameraPermission, setCameraPermission] = useState(null);
  const [locationPermission, setLocationPermission] = useState(null);
  const [backendStatus, setBackendStatus] = useState('Checking…');
  const [locations, setLocations] = useState([]);

  useEffect(() => {
    let active = true;
    const loadStatus = async () => {
      const [camera, location] = await Promise.all([
        Camera.getCameraPermissionsAsync(),
        Location.getForegroundPermissionsAsync(),
      ]);
      if (!active) return;
      setCameraPermission(camera.status);
      setLocationPermission(location.status);
      try {
        const [health, officeResponse] = await Promise.all([
          api.get('/api/health'),
          api.get('/api/office-locations'),
        ]);
        if (active) {
          setBackendStatus(health.data.face_service_configured ? 'Connected; face service configured' : 'Connected; face service not configured');
          setLocations(officeResponse.data || []);
        }
      } catch (error) {
        if (active) setBackendStatus(getApiErrorMessage(error));
      }
    };
    loadStatus();
    return () => {
      active = false;
    };
  }, []);

  return (
    <SafeAreaView style={styles.screenContainer}>
      <Text style={styles.pageHeading}>Permissions</Text>
      <Card title="Device access">
        <Text style={styles.mutedText}>Camera: {cameraPermission || 'unknown'}</Text>
        <Text style={styles.mutedText}>Location: {locationPermission || 'unknown'}</Text>
        <Text style={styles.mutedText}>Backend: {backendStatus}</Text>
      </Card>
      {locations.map((location) => (
        <Card key={location.id} title={location.name}>
          <Text style={styles.mutedText}>Authorized radius: {location.radius_meters} m</Text>
          <Text style={styles.mutedText}>Coordinates: {location.latitude}, {location.longitude}</Text>
        </Card>
      ))}
    </SafeAreaView>
  );
}

function AppNavigator({ user, logout }) {
  return (
    <Stack.Navigator initialRouteName="Dashboard" screenOptions={{ headerShown: true }}>
      <Stack.Screen name="Dashboard" options={{ title: 'Dashboard' }}>
        {(props) => <DashboardScreen {...props} user={user} logout={logout} />}
      </Stack.Screen>
      <Stack.Screen name="FaceEnrollment" options={{ title: 'Enrollment' }}>
        {(props) => <FaceEnrollmentScreen {...props} user={user} />}
      </Stack.Screen>
      <Stack.Screen name="AttendanceCapture" options={{ title: 'Face verification' }} component={FaceVerificationScreen} />
      <Stack.Screen name="EmployeeRegistration" options={{ title: 'Create employee' }} component={EmployeeRegistrationScreen} />
      <Stack.Screen name="History" options={{ title: 'History' }} component={AttendanceHistoryScreen} />
      <Stack.Screen name="Profile" options={{ title: 'Profile' }}>
        {(props) => <ProfileScreen {...props} user={user} />}
      </Stack.Screen>
      <Stack.Screen name="Permissions" options={{ title: 'Permissions' }} component={PermissionScreen} />
      <Stack.Screen name="ResetData" options={{ title: 'Reset data' }}>
        {(props) => <ResetDataScreen {...props} user={user} logout={logout} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

export default function App() {
  const [authUser, setAuthUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const token = await SecureStore.getItemAsync('token');
        if (token) {
          const response = await api.get('/api/employees/me', { headers: { Authorization: `Bearer ${token}` } });
          await saveSession(token, response.data);
          setAuthUser(response.data);
        }
      } catch (error) {
        console.log('Secure storage error', error);
      } finally {
        setLoading(false);
      }
    };

    bootstrap();
  }, []);

  const logout = useCallback(async () => {
    await clearSession();
    setAuthUser(null);
  }, []);

  if (loading) {
    return <SplashScreen navigation={{ replace: () => {} }} />;
  }

  return (
    <NavigationContainer>
      {authUser ? (
        <AppNavigator user={authUser} logout={logout} />
      ) : (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Login">
            {(props) => <LoginScreen {...props} setAuthenticatedUser={setAuthUser} />}
          </Stack.Screen>
        </Stack.Navigator>
      )}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  screenContainer: {
    flex: 1,
    backgroundColor: '#f5f7fb',
    padding: 20,
  },
  centeredScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#101826',
  },
  heroBadge: {
    width: 88,
    height: 88,
    borderRadius: 22,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  logoText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: 'bold',
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: 'bold',
  },
  subtitle: {
    marginTop: 10,
    color: '#dbeafe',
    fontSize: 14,
  },
  pageHeading: {
    fontSize: 28,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 8,
  },
  subText: {
    fontSize: 14,
    color: '#475569',
    marginBottom: 20,
  },
  inputCard: {
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 18,
    marginBottom: 18,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 3,
  },
  label: {
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#dbe3f0',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#f8fafc',
    marginBottom: 14,
  },
  primaryButton: {
    backgroundColor: '#2563eb',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 10,
  },
  primaryButtonLarge: {
    backgroundColor: '#2563eb',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  secondaryButton: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 10,
  },
  secondaryButtonLarge: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    flex: 1,
    marginLeft: 8,
  },
  dangerButton: {
    backgroundColor: '#b91c1c',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 12,
  },
  dangerButtonText: {
    color: '#fff',
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.45,
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '700',
  },
  secondaryButtonText: {
    color: '#fff',
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 16,
    marginBottom: 18,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 18,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 10,
  },
  statLabel: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 8,
  },
  statValue: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  linkButton: {
    backgroundColor: '#e2e8f0',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  linkButtonText: {
    color: '#0f172a',
    fontWeight: '600',
  },
  contentSpacer: {
    paddingBottom: 30,
  },
  cameraPreview: {
    width: '100%',
    height: 420,
    borderRadius: 18,
    overflow: 'hidden',
    marginBottom: 16,
  },
  previewImage: {
    width: '100%',
    height: 420,
    borderRadius: 18,
    marginBottom: 16,
  },
  listSpacing: {
    paddingBottom: 30,
  },
  historyCard: {
    marginBottom: 12,
  },
  mutedText: {
    color: '#475569',
    marginBottom: 2,
  },
  errorText: {
    color: '#b91c1c',
    marginBottom: 12,
  },
});