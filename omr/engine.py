"""Leitura de cartões com marcadores ou do modelo impresso (A) ... (E).

No cartão impresso, localizamos duas séries completas de linhas conforme
a quantidade informada. O modelo com marcadores exige validar todas as bolhas.
"""
import logging
from pathlib import Path

import cv2
import numpy as np

from .pdf_loader import load_image_or_pdf

logger = logging.getLogger(__name__)
CANVAS_WIDTH = 1000
OPTIONS = 'ABCDE'


def order_points(pts):
    pts = np.asarray(pts, dtype=np.float32)
    sums, differences = pts.sum(axis=1), np.diff(pts, axis=1).ravel()
    return pts[[sums.argmin(), differences.argmin(), sums.argmax(), differences.argmax()]]


def grid_height(question_count):
    return ((question_count + 1) // 2) * 44 + 300


def get_grid_coordinates(question_count=50):
    rows = (question_count + 1) // 2
    return {
        str(q): {opt: (160 + (480 if q > rows else 0) + i * 45, 180 + ((q - 1) % rows) * 44)
                 for i, opt in enumerate(OPTIONS)}
        for q in range(1, question_count + 1)
    }


def binarize(gray, adaptive=False):
    # Divisão pelo fundo suavizado compensa sombras sem engrossar letras.
    background = cv2.GaussianBlur(gray, (0, 0), 21)
    normalized = cv2.divide(gray, np.maximum(background, 1), scale=255)
    normalized = cv2.GaussianBlur(normalized, (3, 3), 0)
    if adaptive:
        return cv2.adaptiveThreshold(normalized, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                     cv2.THRESH_BINARY_INV, 41, 15)
    return cv2.threshold(normalized, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]


def detect_fiducial_markers(img_gray):
    """Exige um quadrado sólido em cada canto; nunca inventa marcadores."""
    h, w = img_gray.shape
    contours, _ = cv2.findContours(binarize(img_gray), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    corners = [[] for _ in range(4)]
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        area = cv2.contourArea(contour)
        if not (0.018 * min(w, h) < cw < 0.085 * min(w, h)):
            continue
        if not (0.8 < cw / ch < 1.2 and area / (cw * ch) > 0.85):
            continue
        polygon = cv2.approxPolyDP(contour, 0.035 * cv2.arcLength(contour, True), True)
        if len(polygon) != 4:
            continue
        cx, cy = x + cw / 2, y + ch / 2
        if cx < 0.16 * w and cy < 0.16 * h:
            index = 0
        elif cx > 0.84 * w and cy < 0.16 * h:
            index = 1
        elif cx > 0.84 * w and cy > 0.84 * h:
            index = 2
        elif cx < 0.16 * w and cy > 0.84 * h:
            index = 3
        else:
            continue
        corners[index].append((area, (cx, cy)))
    if not all(corners):
        raise ValueError('Os quatro marcadores quadrados não foram encontrados.')
    return np.float32([max(corner, key=lambda item: item[0])[1] for corner in corners])


def _validate_bubble_grid(binary, coordinates):
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    centers = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if 18 <= w <= 30 and 18 <= h <= 30 and 0.75 < w / h < 1.3:
            centers.append((x + w / 2, y + h / 2))
    if not centers:
        raise ValueError('Não foi possível validar as bolhas do cartão com marcadores.')
    centers = np.array(centers)
    matches = [sum(np.min(np.linalg.norm(centers - point, axis=1)) < 4 for point in row.values())
               for row in coordinates.values()]
    if sum(matches) < len(coordinates) * 5 * 0.96 or min(matches) < 4:
        raise ValueError(f'Os marcadores não correspondem à grade de {len(coordinates)} questões esperada.')


def _row_candidates(binary):
    # Dilatação somente na localização: a medição usa a imagem sem dilatar.
    scale = binary.shape[1] / 1000
    kernel_width = round(14 * scale) + 1
    joined = cv2.dilate(binary, cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_width, max(3, round(3 * scale)))))
    contours, _ = cv2.findContours(joined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    _, w = binary.shape
    rows = []
    for contour in contours:
        x, y, rw, rh = cv2.boundingRect(contour)
        if 0.155 * w <= rw <= 0.32 * w and 8 * scale <= rh <= 0.065 * w and rw / rh > 3.5:
            if x + rw < 0.48 * w or x > 0.43 * w:
                rows.append((x, y, rw, rh, contour))
    return rows


def _find_text_rows(binary, question_count=50, check_alignment=True):
    h, w = binary.shape
    candidates = _row_candidates(binary)
    groups = []
    counts = [(question_count + 1) // 2, question_count // 2]
    for right_column, count in zip((False, True), counts):
        rows = sorted([row for row in candidates if (row[0] > 0.43 * w) == right_column],
                      key=lambda row: row[1] + row[3] / 2)
        sequences = []
        for start in range(len(rows) - count + 1):
            sequence = rows[start:start + count]
            ys = np.array([y + rh / 2 for _, y, _, rh, _ in sequence])
            deltas = np.diff(ys)
            pitch = np.median(deltas) if len(deltas) else sequence[0][3] * 3
            widths = np.array([row[2] for row in sequence])
            if not (0.003 * h < pitch < 0.20 * h):
                continue
            if len(deltas) and np.max(np.abs(deltas - pitch)) > 0.30 * pitch:
                continue
            if np.std(widths) / np.mean(widths) > 0.10:
                continue
            # O cabeçalho deve ficar acima da grade, inclusive em fotos giradas.
            if ys[0] < 0.06 * h or h - ys[-1] > max(ys[0] * 0.9, 0.15 * h):
                continue
            if count >= 10 and ys[-1] - ys[0] < 0.25 * h:
                continue
            # Uma janela menor dentro de uma coluna maior não é uma grade
            # válida: evita descartar as últimas questões silenciosamente.
            adjacent = []
            if start:
                adjacent.append((rows[start - 1], ys[0]))
            if start + count < len(rows):
                adjacent.append((rows[start + count], ys[-1]))
            if any(0.7 * pitch <= abs(y + rh / 2 - edge) <= 1.3 * pitch
                   and abs(rw - np.median(widths)) < np.median(widths) * 0.15
                   for (_, y, rw, rh, _), edge in adjacent):
                continue
            score = (np.std(deltas) / pitch if len(deltas) else 0) + np.std(widths) / np.mean(widths)
            sequences.append((score, sequence))
        if not sequences:
            raise ValueError(f'Não localizei as duas colunas completas de {counts[0]} e {counts[1]} questões. Confira a quantidade cadastrada e envie a folha inteira e legível.')
        groups.append(min(sequences, key=lambda item: item[0])[1])
    left = np.array([y + rh / 2 for _, y, _, rh, _ in groups[0]])
    right = np.array([y + rh / 2 for _, y, _, rh, _ in groups[1]])
    shared = min(len(left), len(right))
    pitch = np.median(np.diff(left)) if len(left) > 1 else groups[0][0][3] * 3
    if check_alignment and np.max(np.abs(left[:shared] - right[:shared])) > pitch * 0.5:
        raise ValueError('As linhas das duas colunas não estão alinhadas. Refaça a foto de frente para a folha.')
    return groups


def _deskew(image, groups):
    angles = []
    for group in groups:
        for *_, contour in group:
            _, (rw, rh), angle = cv2.minAreaRect(contour)
            # Normaliza convenções de ângulo diferentes entre OpenCV 4 e 5.
            angle += 90 if rw < rh else 0
            angles.append((angle + 90) % 180 - 90)
    angle = float(np.median(angles))
    if 0.4 < abs(angle) < 12:
        h, w = image.shape[:2]
        matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1)
        return cv2.warpAffine(image, matrix, (w, h), borderValue=(255, 255, 255))
    return image


def _text_coordinates(binary, groups):
    coordinates, radii = {}, {}
    dilation_margin = round(14 * binary.shape[1] / 1000) / 2
    offset = 0
    for rows in groups:
        median_height = np.median([row[3] for row in rows])
        for index, (x, y, rw, rh, _) in enumerate(rows):
            # Retira a margem da dilatação em cada lado. No modelo (A)...(E),
            # o número da questão ocupa aproximadamente 0,65 passo de opção.
            q = str(offset + index + 1)
            step = (rw - 2 * dilation_margin) / (5.65 + max(0, len(q) - 2) * 0.25)
            right_edge = x + rw - dilation_margin
            coordinates[q], radii[q] = {}, {}
            for option_index, option in enumerate(OPTIONS):
                cx = round(right_edge - (4 - option_index + 0.36) * step)
                # Refina a altura pela tinta da célula: uma rasura não deve
                # deslocar as outras quatro alternativas da mesma linha.
                half_cell = round(step * 0.4)
                cell = binary[y:y + rh, cx - half_cell:cx + half_cell + 1]
                projection = np.count_nonzero(cell, axis=1)
                active = np.flatnonzero(projection >= max(2, projection.max() * 0.25))
                if len(active) < 5:
                    raise ValueError(f'Não localizei a alternativa {option} da questão {q}.')
                cy = round(y + (active[0] + active[-1]) / 2)
                coordinates[q][option] = (cx, cy)
                radii[q][option] = (round(step * 0.24), round(min(median_height - 2, step * 0.5) * 0.40))
        offset += len(rows)
    return coordinates, radii


def locate_grid(image, question_count=50):
    h, w = image.shape[:2]
    # Mais linhas requerem mais resolução para medir a tinta das alternativas.
    target_width = max(1000, min(2200, question_count * 10))
    image = cv2.resize(image, (target_width, round(h * target_width / w)),
                       interpolation=cv2.INTER_AREA if w > target_width else cv2.INTER_CUBIC)
    for rotation in (None, cv2.ROTATE_180, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE):
        oriented = image if rotation is None else cv2.rotate(image, rotation)
        oh, ow = oriented.shape[:2]
        oriented = cv2.resize(oriented, (target_width, round(oh * target_width / ow)))
        gray = cv2.cvtColor(oriented, cv2.COLOR_BGR2GRAY)
        try:
            markers = detect_fiducial_markers(gray)
            height = grid_height(question_count)
            targets = np.float32([(50, 50), (950, 50), (950, height - 50), (50, height - 50)])
            matrix = cv2.getPerspectiveTransform(markers, targets)
            aligned = cv2.warpPerspective(oriented, matrix, (CANVAS_WIDTH, height), borderValue=(255, 255, 255))
            binary = binarize(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY))
            coordinates = get_grid_coordinates(question_count)
            _validate_bubble_grid(binary, coordinates)
            radii = {q: {opt: (8, 8) for opt in OPTIONS} for q in coordinates}
            return aligned, binary, coordinates, radii, 'marcadores'
        except ValueError:
            pass
        for adaptive in (False, True):
            try:
                binary = binarize(gray, adaptive)
                groups = _find_text_rows(binary, question_count, check_alignment=False)
                aligned = _deskew(oriented, groups)
                binary = binarize(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY), adaptive)
                groups = _find_text_rows(binary, question_count)
                coordinates, radii = _text_coordinates(binary, groups)
                return aligned, binary, coordinates, radii, 'cartao_impresso'
            except ValueError:
                continue
    rows = (question_count + 1) // 2
    raise ValueError(f'Modelo não reconhecido para {question_count} questões: use duas colunas de {rows} e {question_count // 2} questões (A a E), numeradas de cima para baixo, ou o modelo compatível com quatro marcadores. Confira a quantidade cadastrada e envie a folha inteira e legível.')


def measure_density(binary, center, radii):
    cx, cy = center
    rx, ry = radii
    roi = binary[cy - ry:cy + ry + 1, cx - rx:cx + rx + 1]
    if roi.shape != (ry * 2 + 1, rx * 2 + 1):
        raise ValueError('Uma alternativa ficou fora da imagem; a folha pode estar cortada.')
    yy, xx = np.ogrid[-ry:ry + 1, -rx:rx + 1]
    mask = (xx / rx) ** 2 + (yy / ry) ** 2 <= 1
    return float(np.mean(roi[mask] > 0))


def classify_densities(densities):
    # Letras também têm tinta: exigimos densidade absoluta e diferença para
    # as alternativas menos preenchidas da questão. O teto preserva duplas.
    baseline = min(float(np.mean(sorted(densities.values())[:2])), 0.40)
    marked = [opt for opt, value in densities.items() if value >= 0.62 and value >= baseline + 0.18]
    if len(marked) > 1:
        return 'RAS'
    uncertain = [opt for opt, value in densities.items()
                 if value >= 0.50 and value >= baseline + 0.12 and opt not in marked]
    if uncertain:
        return 'INC'
    return marked[0] if marked else 'BNK'


def _save_debug(image, coordinates, radii, densities, answers, key, output_path):
    overlay = image.copy()
    for q, row in coordinates.items():
        answer = answers[q]
        for option, (cx, cy) in row.items():
            rx, ry = radii[q][option]
            color = (170, 170, 170)
            if option == answer:
                color = (0, 175, 0) if not key or key.get(q) == option else (0, 0, 220)
            elif answer == 'RAS' and densities[q][option] >= 0.62:
                color = (0, 0, 220)
            elif answer == 'INC' and densities[q][option] >= 0.50:
                color = (255, 100, 0)
            elif key.get(q) == option:
                color = (0, 190, 255)
            # Contornos preservam a tinta original para permitir conferência.
            cv2.ellipse(overlay, (cx, cy), (rx + 3, ry + 3), 0, 0, 360, color, 2)
        cx, cy = row['E']
        cv2.putText(overlay, f'{q}:{answer}', (cx + 24, cy + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.36, (40, 40, 40), 1)
    banner = np.full((82, overlay.shape[1], 3), 40, dtype=np.uint8)
    text = f"Leitura OMR | Alternativas: {sum(v in OPTIONS for v in answers.values())}/{len(answers)} | Brancos: {list(answers.values()).count('BNK')} | Revisar: {list(answers.values()).count('INC')}"
    cv2.putText(banner, text, (20, 33), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
    cv2.putText(banner, 'Contornos preservam a tinta original. INC = leitura incerta.', (20, 62), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (220, 220, 220), 1)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output_path), np.vstack([banner, overlay])):
        raise OSError('Não foi possível salvar o espelho da leitura.')


def process_image(file_path, answer_key=None, output_debug_path=None, question_count=None):
    """Retorna marcações e espelho; persistência e notas pertencem ao NestJS."""
    answer_key = answer_key or {}
    try:
        question_count = question_count if question_count is not None else len(answer_key) or 50
        if isinstance(question_count, bool) or not isinstance(question_count, int) or not 10 <= question_count <= 300:
            raise ValueError('A quantidade deve ser um inteiro entre 10 e 300 questões.')
        image = load_image_or_pdf(file_path, dpi=300)
        aligned, binary, coordinates, radii, layout = locate_grid(image, question_count)
        densities = {q: {option: measure_density(binary, point, radii[q][option])
                         for option, point in row.items()} for q, row in coordinates.items()}
        answers = {q: classify_densities(values) for q, values in densities.items()}
        status = ('ALERTA_REVISAO' if 'INC' in answers.values() else
                  'ALERTA_RASURA' if 'RAS' in answers.values() else 'SUCESSO')
        if output_debug_path:
            _save_debug(aligned, coordinates, radii, densities, answers, answer_key, output_debug_path)
        return {'respostas_detectadas': answers, 'status': status, 'layout': layout,
                'densidades': densities, 'debug_image_path': str(output_debug_path) if output_debug_path else None,
                'erro_msg': ''}
    except Exception as exc:
        logger.warning('Falha na leitura de %s: %s', file_path, exc)
        return {'respostas_detectadas': {}, 'status': 'ERRO_LEITURA',
                'debug_image_path': None, 'erro_msg': str(exc)}
