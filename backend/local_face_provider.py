import base64
import binascii
import json
import os
import ssl
import tempfile
import threading
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import certifi
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python
from mediapipe.tasks.python import vision


ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / 'models'
DATA_DIR = ROOT / 'data'
TEMPLATE_FILE = DATA_DIR / 'face-templates.json'
MATCH_THRESHOLD = float(os.environ.get('FACE_MATCH_THRESHOLD', '0.363'))
YUNET_URL = 'https://github.com/opencv/opencv_zoo/raw/refs/heads/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx'
SFACE_URL = 'https://github.com/opencv/opencv_zoo/raw/refs/heads/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx'
LANDMARKER_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
MODEL_FILES = {
    'yunet': (MODEL_DIR / 'face_detection_yunet_2023mar.onnx', YUNET_URL),
    'sface': (MODEL_DIR / 'face_recognition_sface_2021dec.onnx', SFACE_URL),
    'landmarker': (MODEL_DIR / 'face_landmarker.task', LANDMARKER_URL),
}
EAR_OPEN = 0.23
EAR_CLOSED = 0.18
MIN_SECOND_FACE_AREA_RATIO = 0.25
MAX_IMAGE_BYTES = 6 * 1024 * 1024
MAX_VIDEO_BYTES = 12 * 1024 * 1024
MAX_REQUEST_BYTES = 20 * 1024 * 1024

inference_lock = threading.RLock()
video_analysis_lock = threading.Lock()
template_lock = threading.Lock()
detector = None
recognizer = None
landmarker = None
last_landmarker_timestamp_ms = 0


class ProviderError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def ensure_model(path, url):
    if path.exists() and path.stat().st_size > 0:
        return
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + '.download')
    try:
        tls_context = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(url, timeout=90, context=tls_context) as response, temporary_path.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if temporary_path.stat().st_size < 1024:
            raise RuntimeError(f'Model download was incomplete: {path.name}')
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def initialize_models():
    global detector, recognizer, landmarker
    for model_path, url in MODEL_FILES.values():
        ensure_model(model_path, url)

    detector = cv2.FaceDetectorYN.create(str(MODEL_FILES['yunet'][0]), '', (320, 320), 0.7, 0.3, 5000)
    recognizer = cv2.FaceRecognizerSF.create(str(MODEL_FILES['sface'][0]), '')
    options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=str(MODEL_FILES['landmarker'][0])),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=2,
    )
    landmarker = vision.FaceLandmarker.create_from_options(options)
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    DATA_DIR.chmod(0o700)


def decode_base64(value, label, max_bytes):
    if not isinstance(value, str) or not value:
        raise ProviderError(f'{label} is required')
    encoded = value.split(',', 1)[1] if value.startswith('data:') and ',' in value else value
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ProviderError(f'{label} is not valid base64') from None
    if not decoded or len(decoded) > max_bytes:
        raise ProviderError(f'{label} exceeds the supported size')
    return decoded


def normalize_employee_id(value):
    """
    Coerce a raw employee_id from JSON (string, number, or None) into a
    trimmed non-empty string. Returns None if it cannot be normalized.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        # Reject NaN/Inf; keep integer-like floats as ints.
        if isinstance(value, float):
            if value != value or value in (float('inf'), float('-inf')):
                return None
            if value.is_integer():
                value = int(value)
        value = str(value)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def select_primary_face(faces, allow_small_secondary=False):
    if faces is None or len(faces) == 0:
        raise ProviderError('No face detected. Center your face and improve the lighting.')
    ordered_faces = sorted(faces, key=lambda face: float(face[2] * face[3]), reverse=True)
    if len(ordered_faces) > 1:
        largest_area = float(ordered_faces[0][2] * ordered_faces[0][3])
        second_area = float(ordered_faces[1][2] * ordered_faces[1][3])
        if second_area >= largest_area * MIN_SECOND_FACE_AREA_RATIO:
            if allow_small_secondary:
                return None
            raise ProviderError('Multiple faces detected. Make sure only you are visible in the frame.')
    return ordered_faces[0]


def detect_faces(image):
    height, width = image.shape[:2]
    with inference_lock:
        detector.setInputSize((width, height))
        for candidate in (image, cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(
            cv2.cvtColor(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)[:, :, 0]
        )):
            candidate_image = candidate
            if candidate_image.ndim == 2:
                candidate_image = cv2.cvtColor(candidate_image, cv2.COLOR_GRAY2BGR)
            for threshold in (0.7, 0.5, 0.35):
                detector.setScoreThreshold(threshold)
                _, faces = detector.detect(candidate_image)
                if faces is not None and len(faces):
                    return faces
    return None


def extract_embedding(image_bytes):
    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ProviderError('The captured face image could not be read')
    faces = detect_faces(image)
    face = select_primary_face(faces)
    with inference_lock:
        aligned = recognizer.alignCrop(image, face)
        feature = recognizer.feature(aligned).flatten().astype(np.float32)
    norm = float(np.linalg.norm(feature))
    if not norm:
        raise ProviderError('Could not create a face template from this image')
    return (feature / norm).tolist()


def eye_aspect_ratio(landmarks, width, height, indices):
    points = np.array(
        [[landmarks[index].x * width, landmarks[index].y * height] for index in indices],
        dtype=np.float32,
    )
    horizontal = float(np.linalg.norm(points[0] - points[3]))
    if horizontal < 1:
        return 0.0
    vertical = float(np.linalg.norm(points[1] - points[5]) + np.linalg.norm(points[2] - points[4]))
    return vertical / (2 * horizontal)


def mean_eye_aspect_ratio(landmarks, width, height):
    left = eye_aspect_ratio(landmarks, width, height, (33, 160, 158, 133, 153, 144))
    right = eye_aspect_ratio(landmarks, width, height, (362, 385, 387, 263, 373, 380))
    return (left + right) / 2


def cosine_similarity(first, second):
    with inference_lock:
        return float(recognizer.match(
            np.asarray(first, dtype=np.float32).reshape(1, -1),
            np.asarray(second, dtype=np.float32).reshape(1, -1),
            cv2.FaceRecognizerSF_FR_COSINE,
        ))


def check_blink_and_video_identity(video_bytes, expected_embedding, mime_type):
    with video_analysis_lock:
        return _check_blink_and_video_identity(video_bytes, expected_embedding, mime_type)


def _check_blink_and_video_identity(video_bytes, expected_embedding, mime_type):
    global last_landmarker_timestamp_ms
    suffix = '.mov' if mime_type == 'video/quicktime' else '.mp4'
    temporary_path = None
    capture = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary_file:
            temporary_file.write(video_bytes)
            temporary_path = temporary_file.name
        capture = cv2.VideoCapture(temporary_path)
        if not capture.isOpened():
            return False, False

        fps = capture.get(cv2.CAP_PROP_FPS)
        stride = max(1, round(fps / 10)) if fps and fps > 0 else 3
        opened = False
        closed = False
        blink_seen = False
        matching_frames = 0
        analyzed_frames = 0
        timestamp_ms = last_landmarker_timestamp_ms
        frame_index = 0

        while analyzed_frames < 180:
            success, frame = capture.read()
            if not success:
                break
            current_index = frame_index
            frame_index += 1
            if current_index % stride:
                continue

            height, width = frame.shape[:2]
            faces = detect_faces(frame)
            face = select_primary_face(faces, allow_small_secondary=True)
            if face is None:
                continue

            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
            timestamp_ms += max(1, round(1000 * stride / fps)) if fps and fps > 0 else 100
            last_landmarker_timestamp_ms = timestamp_ms
            try:
                with inference_lock:
                    result = landmarker.detect_for_video(mp_image, timestamp_ms)
            except Exception as error:
                raise ProviderError('Could not analyze the blink video. Please record a new blink challenge.', 422) from error
            if len(result.face_landmarks) != 1:
                continue

            landmarks = result.face_landmarks[0]
            ear = mean_eye_aspect_ratio(landmarks, width, height)
            if ear >= EAR_OPEN:
                if closed:
                    blink_seen = True
                opened = True
                closed = False
            elif ear <= EAR_CLOSED and opened:
                closed = True

            with inference_lock:
                aligned = recognizer.alignCrop(frame, face)
                feature = recognizer.feature(aligned).flatten().astype(np.float32)
            norm = float(np.linalg.norm(feature))
            if norm:
                frame_embedding = (feature / norm).tolist()
                if cosine_similarity(frame_embedding, expected_embedding) >= MATCH_THRESHOLD:
                    matching_frames += 1
            analyzed_frames += 1

        identity_in_video = matching_frames >= 3
        return blink_seen and identity_in_video, identity_in_video
    finally:
        if capture is not None:
            capture.release()
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)


def load_templates():
    if not TEMPLATE_FILE.exists():
        return {}
    try:
        return json.loads(TEMPLATE_FILE.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        raise RuntimeError('Local face template storage is unreadable') from None


def save_template(employee_id, embedding):
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    DATA_DIR.chmod(0o700)
    with template_lock:
        templates = load_templates()
        template_id = str(uuid.uuid4())
        templates[employee_id] = {'template_id': template_id, 'embedding': embedding}
        temporary_path = TEMPLATE_FILE.with_suffix('.json.tmp')
        temporary_path.write_text(json.dumps(templates), encoding='utf-8')
        temporary_path.chmod(0o600)
        temporary_path.replace(TEMPLATE_FILE)
    return template_id


def load_template(employee_id):
    with template_lock:
        return load_templates().get(employee_id)


def delete_template(employee_id):
    with template_lock:
        templates = load_templates()
        existed = templates.pop(employee_id, None) is not None
        if not existed:
            return False
        if templates:
            temporary_path = TEMPLATE_FILE.with_suffix('.json.tmp')
            temporary_path.write_text(json.dumps(templates), encoding='utf-8')
            temporary_path.chmod(0o600)
            temporary_path.replace(TEMPLATE_FILE)
        else:
            TEMPLATE_FILE.unlink(missing_ok=True)
        return True


def delete_all_templates():
    """Delete every stored face template. Returns the number of templates removed."""
    with template_lock:
        templates = load_templates()
        count = len(templates)
        if count == 0:
            return 0
        TEMPLATE_FILE.unlink(missing_ok=True)
        return count


def count_templates():
    with template_lock:
        return len(load_templates())


def resolve_reset_scope(body):
    """
    Accept either the React-style payload ({ scope, employee_id })
    or the legacy provider-style payload ({ employee_id }).
    Returns (scope, normalized_employee_id_or_None).
    """
    scope = body.get('scope')
    employee_id = normalize_employee_id(body.get('employee_id'))

    if scope == 'all':
        return 'all', None

    if scope == 'employee_face':
        if not employee_id:
            raise ProviderError("Employee ID is required for a per-employee reset (scope='employee_face')")
        return 'employee_face', employee_id

    if scope in (None, '', 'attendance'):
        if not employee_id:
            return 'all', None
        return 'employee_face', employee_id

    raise ProviderError(f'Unknown reset scope: {scope!r}')


class FaceProviderHandler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        response = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def do_GET(self):
        if self.path == '/health':
            return self.send_json(200, {'status': 'ok', 'mode': 'local', 'templates': count_templates()})
        if self.path == '/templates/count':
            return self.send_json(200, {'count': count_templates()})
        return self.send_json(404, {'message': 'Not found'})

    def do_POST(self):
        if self.path not in ('/enroll', '/verify', '/reset'):
            return self.send_json(404, {'message': 'Not found'})
        try:
            content_length = int(self.headers.get('Content-Length', '0'))
            if content_length < 1 or content_length > MAX_REQUEST_BYTES:
                raise ProviderError('Request body is empty or exceeds the 20 MB limit', 413)
            body = json.loads(self.rfile.read(content_length))

            if not isinstance(body, dict):
                raise ProviderError('Request body must be a JSON object')

            # ----- /reset: per-employee or full wipe -----
            if self.path == '/reset':
                scope, employee_id = resolve_reset_scope(body)
                if scope == 'all':
                    deleted = delete_all_templates()
                    return self.send_json(200, {'scope': 'all', 'deleted': deleted})
                deleted = delete_template(employee_id)
                return self.send_json(200, {
                    'scope': 'employee_face',
                    'employee_id': employee_id,
                    'deleted': deleted,
                })

            # ----- /enroll and /verify: employee_id is mandatory -----
            raw_employee_id = body.get('employee_id')
            employee_id = normalize_employee_id(raw_employee_id)
            if not employee_id:
                raise ProviderError(
                    f"Employee ID is required (path={self.path}, "
                    f"received={raw_employee_id!r}, keys={sorted(body.keys())})"
                )

            image_bytes = decode_base64(body.get('image_base64'), 'Face image', MAX_IMAGE_BYTES)
            video_bytes = decode_base64(body.get('liveness_video_base64'), 'Blink challenge video', MAX_VIDEO_BYTES)
            mime_type = body.get('liveness_video_mime_type', 'video/mp4')
            if mime_type not in ('video/mp4', 'video/quicktime'):
                raise ProviderError('Only MP4 and QuickTime blink videos are supported')

            with inference_lock:
                image_embedding = extract_embedding(image_bytes)

            if self.path == '/enroll':
                liveness_passed, same_person = check_blink_and_video_identity(video_bytes, image_embedding, mime_type)
                if not liveness_passed or not same_person:
                    return self.send_json(422, {
                        'message': 'Blink check failed or the video face did not match the enrollment image',
                        'liveness_passed': False,
                    })
                template_id = save_template(employee_id, image_embedding)
                return self.send_json(200, {
                    'liveness_passed': True,
                    'face_detected': True,
                    'template_id': template_id,
                })

            # ----- /verify -----
            template = load_template(employee_id)
            if not template:
                raise ProviderError('No local face template is enrolled for this employee', 404)
            confidence = cosine_similarity(image_embedding, template['embedding'])
            liveness_passed, same_person = check_blink_and_video_identity(video_bytes, template['embedding'], mime_type)
            matched = confidence >= MATCH_THRESHOLD and liveness_passed and same_person
            return self.send_json(200, {
                'matched': matched,
                'liveness_passed': liveness_passed,
                'confidence': confidence,
                'employee_id': employee_id,
            })
        except ProviderError as error:
            return self.send_json(error.status, {'message': str(error)})
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json(400, {'message': 'Request body must be valid JSON'})
        except Exception as error:
            print(f'Local face provider error: {error}', flush=True)
            return self.send_json(500, {'message': 'Local face verification failed'})

    def log_message(self, format_string, *args):
        print(f'Local face provider: {format_string % args}', flush=True)


def main():
    initialize_models()
    server = ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('LOCAL_FACE_PROVIDER_PORT', '8765'))), FaceProviderHandler)
    print('Local face provider ready on 127.0.0.1:8765', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()