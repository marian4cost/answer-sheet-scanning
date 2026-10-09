"""Decodificação consistente de PDF e fotos para matrizes BGR do OpenCV."""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from pdf2image import convert_from_path

from .validation import IMAGE_FORMATS, MAX_IMAGE_PIXELS


def convert_pdf_to_opencv_image(pdf_path, dpi=300, page_num=1):
    if not Path(pdf_path).is_file():
        raise FileNotFoundError(f'Arquivo não encontrado: {pdf_path}')
    # Preserva o fluxo original: um cartão por arquivo, na primeira página.
    pages = convert_from_path(pdf_path, first_page=page_num, last_page=page_num,
                              dpi=dpi, size=3200, timeout=30)
    if not pages:
        raise ValueError(f'Não foi possível converter a página {page_num} do PDF.')
    return cv2.cvtColor(np.asarray(pages[0].convert('RGB')), cv2.COLOR_RGB2BGR)


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
            # Fotos de celular podem armazenar a rotação apenas no EXIF.
            image = ImageOps.exif_transpose(source)
            # Transparência deve ser papel branco, em vez de fundo preto.
            rgba = image.convert('RGBA')
            background = Image.new('RGBA', rgba.size, 'white')
            image = Image.alpha_composite(background, rgba).convert('RGB')
            image.thumbnail((3200, 3200), Image.Resampling.LANCZOS)
            return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError('Não foi possível decodificar a imagem enviada.') from exc
