"""Validação compartilhada pelos três formulários de envio."""
from pathlib import Path
import warnings

from PIL import Image, UnidentifiedImageError

IMAGE_FORMATS = {
    '.jpg': 'JPEG', '.jpeg': 'JPEG', '.png': 'PNG', '.webp': 'WEBP',
    '.bmp': 'BMP', '.tif': 'TIFF', '.tiff': 'TIFF',
}
SUPPORTED_EXTENSIONS = {'.pdf', *IMAGE_FORMATS}
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
FORMAT_LABEL = 'PDF, JPEG/JPG, PNG, WEBP, BMP ou TIFF'


def _validate_stream(upload, filename, size):
    extension = Path(filename).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError(f'{filename}: formato não suportado. Use {FORMAT_LABEL}.')
    if not size or size > MAX_UPLOAD_BYTES:
        raise ValueError(f'{filename}: envie um arquivo de até 20 MB, com conteúdo válido.')
    try:
        upload.seek(0)
        if extension == '.pdf':
            if not upload.read(1024).lstrip().startswith(b'%PDF-'):
                raise ValueError('O conteúdo não corresponde a um PDF válido.')
        else:
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(upload) as image:
                    if image.format != IMAGE_FORMATS[extension]:
                        raise ValueError('A extensão não corresponde ao formato da imagem.')
                    if image.width * image.height > MAX_IMAGE_PIXELS:
                        raise ValueError('A imagem excede o limite de 40 megapixels.')
                    image.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError(f'{filename}: imagem inválida ou muito grande.') from exc
    finally:
        upload.seek(0)


def validate_file(path):
    path = Path(path)
    with path.open('rb') as stream:
        _validate_stream(stream, path.name, path.stat().st_size)
