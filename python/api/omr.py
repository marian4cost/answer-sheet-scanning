"""Função Vercel: somente decodificação e leitura; notas pertencem ao NestJS."""
import base64
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlparse, unquote, parse_qsl
from urllib.request import Request, build_opener, HTTPRedirectHandler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cv2
from omr.engine import process_image
from omr.validation import validate_file
from omr.pdf_loader import document_info
from omr.identity import inspect_document, extract_page_identity

MAX_FILE = 20 * 1024 * 1024
cv2.setNumThreads(1)

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Redirecionamento de arquivo não permitido.')

def safe_url(value):
    configured = urlparse(os.environ.get('SUPABASE_URL', ''))
    url = urlparse(value if isinstance(value, str) else '')
    bucket = os.environ.get('SUPABASE_STORAGE_BUCKET', 'omr-private')
    prefix = '/storage/v1/object/sign/' + bucket + '/'
    path = unquote(url.path)
    # Todos os três fluxos pertencem ao armazenamento privado da aplicação:
    # incoming (upload assinado), importing (lote persistido) e processing
    # (cópia temporária). Não aceita nomes originais nem diretórios arbitrários.
    object_path = re.escape(prefix) + r'(incoming|importing|processing)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png|webp|bmp|tif|tiff)'
    try:
        query = parse_qsl(url.query, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        query = []
    if (configured.scheme != 'https' or url.scheme != 'https' or url.netloc != configured.netloc
            or url.username or url.password or not re.fullmatch(object_path, path)
            or path != url.path or url.params or url.fragment
            or len(query) != 1 or query[0][0] != 'token' or not query[0][1]
            or not isinstance(value, str) or re.search(r'[\x00-\x20\x7f]', value)):
        raise ValueError('Origem do arquivo não permitida.')
    return value

def receive_file(data, directory, index=0):
    name = data.get('name') or data.get('file_name') or 'input.png'
    extension = Path(name).suffix.lower()
    if extension not in {'.pdf', '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'}:
        raise ValueError('Formato de arquivo não suportado.')
    if data.get('file_url'):
        with build_opener(NoRedirect()).open(Request(safe_url(data['file_url'])), timeout=25) as response:
            length = response.headers.get('Content-Length')
            if length and int(length) > MAX_FILE:
                raise ValueError('O arquivo deve conter até 20 MB.')
            content = response.read(MAX_FILE + 1)
    else:
        encoded = data.get('file_base64', '')
        if not isinstance(encoded, str) or len(encoded) > 4_000_000:
            raise ValueError('Use o armazenamento privado para enviar este arquivo.')
        content = base64.b64decode(encoded, validate=True)
    if not content or len(content) > MAX_FILE:
        raise ValueError('O arquivo deve conter até 20 MB.')
    path = Path(directory) / (str(index) + extension)
    path.write_bytes(content)
    validate_file(path)
    return str(path)

def execute(payload):
    action = payload.get('action', 'process')
    if action == 'health':
        return {'ok': True, 'opencv': cv2.__version__, 'pdf_engine': 'PDFium', 'poppler': False}
    with tempfile.TemporaryDirectory(prefix='enem-omr-') as directory:
        if action == 'validate':
            files = payload.get('files')
            if not isinstance(files, list) or not 1 <= len(files) <= 50:
                raise ValueError('Informe arquivos válidos.')
            for index, data in enumerate(files):
                receive_file(data, directory, index)
            return {'ok': True}
        if action not in {'process', 'document_info', 'inspect_document'}:
            raise ValueError('Ação inválida.')
        path = receive_file(payload, directory)
        if action == 'document_info':
            return document_info(path)
        if action == 'inspect_document':
            return inspect_document(path, payload.get('page_numbers'))
        debug = str(Path(directory) / 'debug.png') if payload.get('debug') else None
        reading = process_image(path, payload.get('answer_key'), debug,
                                question_count=payload.get('question_count', 50), page_number=payload.get('page_number'))
        reading['page_number'] = payload.get('page_number') if payload.get('page_number') is not None else 1
        if payload.get('include_identity', True) and reading['status'] != 'ERRO_LEITURA':
            identity = extract_page_identity(path, payload.get('page_number') or 1)
            reading['matricula_erro_msg'] = identity.pop('erro_msg')
            reading.update(identity)
        reading['debug_image_path'] = None
        if debug and Path(debug).is_file():
            image = cv2.imread(debug)
            scale = min(1, 1600 / max(image.shape[:2]))
            if scale < 1:
                image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            ok, encoded = cv2.imencode('.png', image)
            if ok and len(encoded) <= 2_500_000:
                reading['debug_image_base64'] = base64.b64encode(encoded).decode('ascii')
        return reading

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        secret = os.environ.get('OMR_REMOTE_SECRET', '')
        provided = self.headers.get('X-OMR-Secret', '')
        if not secret or not hmac.compare_digest(secret.encode('utf-8'), provided.encode('utf-8')):
            return self.send_json(401, {'error': 'Acesso não autorizado.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4_000_000:
                raise ValueError('Solicitação inválida ou muito grande.')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError('Solicitação inválida.')
            result = execute(payload)
            self.send_json(200, result)
        except ValueError as error:
            self.send_json(400, {'error': str(error)})
        except Exception:
            self.send_json(500, {'error': 'Não foi possível processar o arquivo. Confira o formato e a legibilidade.'})
    def do_GET(self):
        self.send_json(405, {'error': 'Utilize POST autenticado.'})
    def send_json(self, status, data):
        content = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)
    def log_message(self, *_args):
        pass
