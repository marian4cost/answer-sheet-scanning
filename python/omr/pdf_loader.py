"""Decodificação de PDF/fotos sem processo externo nem dependência do Django."""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
import pypdfium2 as pdfium
from threading import RLock

# PDFium exige serialização entre threads do mesmo processo. Os workers
# CLI podem continuar paralelos, pois usam processos separados.
_PDF_LOCK = RLock()

from .validation import IMAGE_FORMATS, MAX_IMAGE_PIXELS


def convert_pdf_to_opencv_image(pdf_path, dpi=300, page_num=1):
    if not Path(pdf_path).is_file():
        raise FileNotFoundError(f'Arquivo não encontrado: {pdf_path}')
    # Um cartão por arquivo, na primeira página. Restringe resolução ANTES
    # da rasterização, impedindo uma página gigante de esgotar a memória.
    try:
        with _PDF_LOCK, pdfium.PdfDocument(str(pdf_path)) as document:
            if not 1 <= page_num <= len(document):
                raise ValueError(f'O PDF não contém a página {page_num}.')
            page = document[page_num - 1]
            width, height = page.get_size()
            if width <= 0 or height <= 0:
                raise ValueError('A página do PDF possui tamanho inválido.')
            scale = min(dpi / 72, 3200 / max(width, height))
            bitmap = page.render(scale=scale, fill_color=(255, 255, 255, 255))
            image = np.asarray(bitmap.to_pil().convert('RGB')).copy()
            bitmap.close()
            return cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError('Não foi possível decodificar o PDF enviado.') from exc


def load_image_or_pdf(file_path, dpi=300):
    extension = Path(file_path).suffix.lower()
    if extension == '.pdf':
        return convert_pdf_to_opencv_image(file_path, dpi=dpi)
    if extension not in IMAGE_FORMATS:
        raise ValueError('Formato de imagem não suportado.')
    try:
        with Image.open(file_path) as source:
            if source.format != IMAGE_FORMATS[extension]:
                raise ValueError('A extensão não corresponde ao conteúdo da imagem.')
            if source.width * source.height > MAX_IMAGE_PIXELS:
                raise ValueError('A imagem excede o limite de 40 megapixels.')
            image = ImageOps.exif_transpose(source)
            rgba = image.convert('RGBA')
            image = Image.alpha_composite(Image.new('RGBA', rgba.size, 'white'), rgba).convert('RGB')
            image.thumbnail((3200, 3200), Image.Resampling.LANCZOS)
            return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError('Não foi possível decodificar a imagem enviada.') from exc
