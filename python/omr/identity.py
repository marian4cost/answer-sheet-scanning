"""Matrícula da página: texto PDF ou OCR local, sempre ancorado no rótulo.

Não utiliza nome do arquivo, gabarito, contato ou número encontrado ao acaso.
Leituras ambíguas ou de baixa confiança exigem conferência na aplicação.
"""
from functools import lru_cache
from pathlib import Path
import re
from threading import RLock
import unicodedata

import cv2
import numpy as np

from .pdf_loader import document_info, extract_pdf_page_text, load_image_or_pdf, validate_page_number
from .validation import validate_file

MAX_INSPECTION_PAGES = 5
MIN_OCR_CONFIDENCE = .92
_OCR_LOCK = RLock()
_LABEL = re.compile(r'\bmatricula\b\s*[:：#-]?\s*', re.IGNORECASE)
_VALUE = re.compile(r'([0-9]{4,30})(?![0-9A-Za-z])')


def _normalized(text):
    # Só o rótulo perde diacríticos; números não são corrigidos (O != 0).
    return ''.join(char for char in unicodedata.normalize('NFKD', text)
                   if not unicodedata.combining(char))


def labelled_candidates(text):
    """Retorna valores textuais únicos e informa se um rótulo foi encontrado."""
    text = _normalized(text)
    candidates, labelled = [], False
    for label in _LABEL.finditer(text):
        labelled = True
        value = _VALUE.match(text, label.end())
        if value and value.group(1) not in candidates:
            candidates.append(value.group(1))
    return candidates, labelled


def identity_result(candidates=(), *, source=None, confidence=None, labelled=False, error=''):
    candidates = sorted(set(candidates))
    if len(candidates) > 1:
        status, value = 'AMBIGUA', None
        error = error or 'Mais de uma matrícula diferente foi encontrada na página. Confira a identificação.'
    elif candidates and (source == 'pdf_texto' or confidence is not None and confidence >= MIN_OCR_CONFIDENCE):
        status, value = 'CONFIRMADA', candidates[0]
    elif candidates or labelled or error:
        status, value = 'INCERTA', None
        error = error or 'A matrícula precisa de conferência; a leitura não possui confiança suficiente.'
    else:
        status, value = 'AUSENTE', None
        error = 'Não encontrei uma matrícula legível junto ao rótulo Matrícula no cabeçalho.'
    return {'matricula_detectada': value, 'matricula_status': status,
            'matricula_fonte': source, 'matricula_candidatas': candidates,
            'matricula_confianca': round(float(confidence), 5) if confidence is not None else None,
            'erro_msg': error}


@lru_cache(maxsize=1)
def _ocr_engine():
    # Caminhos explícitos e modelos empacotados: não baixar nada em runtime.
    import rapidocr
    from rapidocr import RapidOCR
    models = Path(rapidocr.__file__).resolve().parent / 'models'
    det, rec = models / 'PP-OCRv6_det_small.onnx', models / 'PP-OCRv6_rec_small.onnx'
    if not det.is_file() or not rec.is_file():
        raise RuntimeError('Os modelos OCR locais não estão disponíveis.')
    return RapidOCR(params={
        'Global.log_level': 'critical', 'Global.use_cls': False,
        'Global.text_score': .45, 'Global.max_side_len': 2000,
        'EngineConfig.onnxruntime.intra_op_num_threads': 1,
        'EngineConfig.onnxruntime.inter_op_num_threads': 1,
        'Det.model_path': str(det), 'Rec.model_path': str(rec),
    })


def _ocr_candidates(output):
    texts = output.txts if output.txts is not None else []
    scores = output.scores if output.scores is not None else []
    boxes = output.boxes if output.boxes is not None else []
    candidates, labelled, confidences = [], False, []
    for index, (text, confidence) in enumerate(zip(texts, scores)):
        values, has_label = labelled_candidates(text)
        if not has_label:
            continue
        labelled = True
        # O detector pode separar o rótulo e o valor em duas caixas. Une
        # somente a caixa imediatamente à direita na mesma linha visual.
        if not values and index < len(boxes):
            box = np.asarray(boxes[index])
            right, y = float(box[:, 0].max()), float(box[:, 1].mean())
            height = max(1., float(np.ptp(box[:, 1])))
            following = []
            for j, next_box in enumerate(boxes):
                if j == index:
                    continue
                next_box = np.asarray(next_box)
                x = float(next_box[:, 0].min())
                if 0 <= x - right <= height * 5 and abs(float(next_box[:, 1].mean()) - y) <= height * .55:
                    following.append((x, j))
            if following:
                j = min(following)[1]
                values, _ = labelled_candidates(text + ' ' + texts[j])
                confidence = min(float(confidence), float(scores[j]))
        for value in values:
            candidates.append(value)
            confidences.append(float(confidence))
    return candidates, labelled, min(confidences) if confidences else None


def extract_image_identity(image):
    """OCR do cabeçalho nas quatro orientações; aceita somente rótulo+valor."""
    all_candidates, labelled, scores = [], False, []
    try:
        with _OCR_LOCK:
            for rotation in (None, cv2.ROTATE_180, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE):
                oriented = image if rotation is None else cv2.rotate(image, rotation)
                header = oriented[:max(1, round(oriented.shape[0] * .42))]
                # Folha branca/cortada sem texto não precisa carregar os modelos.
                gray = cv2.cvtColor(header, cv2.COLOR_BGR2GRAY)
                if np.count_nonzero(gray < 180) < gray.size * .0005:
                    continue
                scale = min(1., 1700 / header.shape[1])
                if scale < 1:
                    header = cv2.resize(header, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
                values, has_label, confidence = _ocr_candidates(_ocr_engine()(header, use_cls=False))
                all_candidates.extend(values)
                labelled |= has_label
                if confidence is not None:
                    scores.append(confidence)
                # Não usa a orientação para desempatar números diferentes.
                if len(set(values)) > 1 or values and confidence is not None and confidence >= MIN_OCR_CONFIDENCE:
                    return identity_result(all_candidates, source='ocr', confidence=min(scores), labelled=labelled)
    except Exception:
        return identity_result(all_candidates, source='ocr', labelled=labelled,
                               error='Não foi possível executar o OCR local da matrícula. Confira a identificação manualmente.')
    return identity_result(all_candidates, source='ocr' if labelled else None,
                           confidence=min(scores) if scores else None, labelled=labelled)


def extract_page_identity(file_path, page_number=1, image=None):
    info = document_info(file_path)
    validate_page_number(page_number, info['page_count'])
    if Path(file_path).suffix.lower() == '.pdf':
        try:
            text = extract_pdf_page_text(file_path, page_number)
        except ValueError:
            text = ''  # Camada de texto danificada pode continuar legível por OCR.
        values, labelled = labelled_candidates(text)
        if values:
            return identity_result(values, source='pdf_texto', labelled=labelled, confidence=1.)
    try:
        image = image if image is not None else load_image_or_pdf(file_path, dpi=180, page_number=page_number)
    except (ValueError, OSError):
        return identity_result(error='Não foi possível ler o cabeçalho desta página. Confira a matrícula manualmente.')
    return extract_image_identity(image)


def inspect_document(file_path, page_numbers=None):
    """Uma chamada inspeciona até cinco páginas; o total sempre é devolvido."""
    validate_file(file_path)
    info = document_info(file_path)
    if page_numbers is None:
        if info['page_count'] > MAX_INSPECTION_PAGES:
            raise ValueError('Informe page_numbers para inspecionar até cinco páginas por chamada.')
        page_numbers = list(range(1, info['page_count'] + 1))
    if not isinstance(page_numbers, list) or not 1 <= len(page_numbers) <= MAX_INSPECTION_PAGES:
        raise ValueError('Informe de uma a cinco páginas distintas em page_numbers.')
    for number in page_numbers:
        validate_page_number(number, info['page_count'])
    if len(set(page_numbers)) != len(page_numbers):
        raise ValueError('Informe de uma a cinco páginas distintas em page_numbers.')
    return {**info, 'pages': [{'page_number': number, **extract_page_identity(file_path, number)}
                            for number in page_numbers]}
