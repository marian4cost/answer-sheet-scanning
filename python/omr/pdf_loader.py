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

MAX_DOCUMENT_PAGES = 100


def validate_page_number(page_number, page_count):
    if (isinstance(page_number, bool) or not isinstance(page_number, int)
            or not 1 <= page_number <= page_count):
        raise ValueError(f'Informe uma página inteira entre 1 e {page_count}.')
    return page_number


def document_info(file_path):
    """Inspeção barata: não rasteriza nem executa OCR."""
    if Path(file_path).suffix.lower() != '.pdf':
        return {'page_count': 1, 'document_type': 'imagem',
                'format': Path(file_path).suffix[1:].upper(), 'max_pages': MAX_DOCUMENT_PAGES}
    try:
        with _PDF_LOCK, pdfium.PdfDocument(str(file_path)) as document:
            count = len(document)
            if not 1 <= count <= MAX_DOCUMENT_PAGES:
                raise ValueError(f'O PDF deve conter de 1 a {MAX_DOCUMENT_PAGES} páginas.')
            if pdfium.raw.FPDF_GetSecurityHandlerRevision(document.raw) != -1:
                raise ValueError('Envie um PDF sem senha ou criptografia.')
            for number in range(count):
                width, height = document.get_page_size(number)
                if not np.isfinite([width, height]).all() or min(width, height) <= 0:
                    raise ValueError('Uma página do PDF possui tamanho inválido.')
                if max(width, height) / min(width, height) > 10:
                    raise ValueError('Uma página do PDF possui proporções incompatíveis com um cartão de respostas.')
            return {'page_count': count, 'document_type': 'pdf', 'format': 'PDF', 'max_pages': MAX_DOCUMENT_PAGES}
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError('Não foi possível abrir o PDF. Confira se está válido e sem senha.') from exc


def extract_pdf_page_text(pdf_path, page_number=1):
    """Camada textual da página, sem metadados ou campos de outras páginas."""
    try:
        with _PDF_LOCK, pdfium.PdfDocument(str(pdf_path)) as document:
            validate_page_number(page_number, len(document))
            page = document[page_number - 1]
            try:
                textpage = page.get_textpage()
                try:
                    return textpage.get_text_range()
                finally:
                    textpage.close()
            finally:
                page.close()
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError('Não foi possível extrair o texto da página do PDF.') from exc


def convert_pdf_to_opencv_image(pdf_path, dpi=300, page_num=1):
    if not Path(pdf_path).is_file():
        raise FileNotFoundError(f'Arquivo não encontrado: {pdf_path}')
    # Restringe resolução ANTES da rasterização, impedindo uma página
    # gigante de esgotar a memória. A seleção de página é sempre explícita.
    try:
        with _PDF_LOCK, pdfium.PdfDocument(str(pdf_path)) as document:
            validate_page_number(page_num, len(document))
            page = document[page_num - 1]
            width, height = page.get_size()
            if width <= 0 or height <= 0:
                raise ValueError('A página do PDF possui tamanho inválido.')
            scale = min(dpi / 72, 3200 / max(width, height))
            try:
                bitmap = page.render(scale=scale, fill_color=(255, 255, 255, 255))
                try:
                    image = np.asarray(bitmap.to_pil().convert('RGB')).copy()
                finally:
                    bitmap.close()
            finally:
                page.close()
            return cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError('Não foi possível decodificar o PDF enviado.') from exc


def load_image_or_pdf(file_path, dpi=300, page_number=None):
    extension = Path(file_path).suffix.lower()
    if extension == '.pdf':
        count = document_info(file_path)['page_count']
        if page_number is None:
            if count > 1:
                raise ValueError('O PDF contém várias páginas. Selecione a página ou use a importação em lote.')
            page_number = 1
        validate_page_number(page_number, count)
        return convert_pdf_to_opencv_image(file_path, dpi=dpi, page_num=page_number)
    if page_number is not None:
        validate_page_number(page_number, 1)
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
