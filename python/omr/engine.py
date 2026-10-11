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
        if 0.13 * w <= rw <= 0.38 * w and 8 * scale <= rh <= 0.065 * w and rw / rh > 3.5:
            rows.append((x, y, rw, rh, contour))
    return rows


def _find_text_rows(binary, question_count=50, check_alignment=True):
    h, w = binary.shape
    candidates = _row_candidates(binary)
    groups = []
    if len(candidates) < question_count:
        raise ValueError('Não há linhas suficientes para a quantidade cadastrada.')
    # Divide as colunas pelo maior vão entre origens x observadas. Margens
    # da foto/página podem variar: nenhum x absoluto do antigo cartão entra.
    origins = np.sort([row[0] for row in candidates])
    gaps = np.diff(origins)
    gap_index = int(np.argmax(gaps))
    if gaps[gap_index] < .15 * w:
        raise ValueError('Não localizei duas colunas separadas.')
    column_boundary = float((origins[gap_index] + origins[gap_index + 1]) / 2)
    counts = [(question_count + 1) // 2, question_count // 2]
    for right_column, count in zip((False, True), counts):
        rows = sorted([row for row in candidates if (row[0] > column_boundary) == right_column],
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
            if np.std(widths) / np.mean(widths) > 0.18:
                continue
            # O cabeçalho deve ficar acima da grade, inclusive em fotos giradas.
            if ys[0] < 0.04 * h:
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
            if any(0.8 * pitch <= abs(y + rh / 2 - edge) <= 1.15 * pitch
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


def _rectify_columns(image, groups):
    """Corrige perspectiva pelas extremidades da própria grade detectada.

    As 4 âncoras são as linhas inicial/final das duas colunas, inclusive
    quando nenhuma alternativa está marcada. Não registra contra uma foto
    do professor nem compara padrões de respostas para achar coordenadas.
    """
    left, right = groups
    pitch = float(np.median(np.diff([row[1] + row[3] / 2 for row in left])))
    anchors = np.float32([
        (left[0][0], left[0][1] + left[0][3] / 2),
        (right[0][0] + right[0][2], right[0][1] + right[0][3] / 2),
        (right[-1][0] + right[-1][2], right[-1][1] + right[-1][3] / 2),
        (left[-1][0], left[-1][1] + left[-1][3] / 2),
    ])
    # Totais ímpares têm uma linha a menos à direita; extrapola uma linha
    # apenas para a transformação. A contagem final permanece estrita.
    if len(left) > len(right):
        anchors[2][1] += float(np.median(np.diff([row[1] + row[3] / 2 for row in right])))
    differences = [abs(anchors[0][1] - anchors[1][1]), abs(anchors[3][1] - anchors[2][1])]
    if max(differences) <= .25 * pitch:
        return image
    x0 = min(anchors[0][0], anchors[3][0])
    x1 = max(anchors[1][0], anchors[2][0])
    y0 = float(np.mean(anchors[:2, 1]))
    y1 = float(np.mean(anchors[2:, 1]))
    target = np.float32([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
    matrix = cv2.getPerspectiveTransform(anchors, target)
    return cv2.warpPerspective(image, matrix, (image.shape[1], image.shape[0]), borderValue=(255, 255, 255))


def _text_coordinates(binary, groups):
    coordinates, radii = {}, {}
    invalid_rows = 0
    dilation_margin = round(14 * binary.shape[1] / 1000) / 2
    offset = 0
    for rows in groups:
        median_height = np.median([row[3] for row in rows])
        for index, (x, y, rw, rh, _) in enumerate(rows):
            # Remove a margem da dilatação. Esta aproximação só inicia a
            # busca: as cinco letras/bolhas abaixo refinam passo e origem.
            q = str(offset + index + 1)
            step = (rw - 2 * dilation_margin) / 5.65
            right_edge = x + rw - dilation_margin
            # Localiza as cinco letras/marcações como componentes centrais.
            # Os parênteses são estreitos; números à esquerda não pertencem
            # às cinco posições à direita. Confere o passo antes de aceitar.
            parts, _ = cv2.findContours(binary[y:y + rh, x:x + rw], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            centers = []
            for part in parts:
                gx, gy, gw, gh = cv2.boundingRect(part)
                if gw >= .16 * step and gh >= .35 * median_height and gw < step * .95:
                    centers.append(x + gx + gw / 2)
            centers = sorted(centers)[-5:]
            if len(centers) == 5:
                observed = float(np.median(np.diff(centers)))
                valid = .7 * step < observed < 1.3 * step and max(abs(np.diff(centers) - observed)) < .22 * observed and right_edge - centers[-1] < .65 * observed
                if valid:
                    step = observed
                else:
                    centers = []
            if len(centers) != 5:
                invalid_rows += 1
            coordinates[q], radii[q] = {}, {}
            for option_index, option in enumerate(OPTIONS):
                cx = round(centers[option_index] if len(centers) == 5 else right_edge - (4 - option_index + 0.36) * step)
                # Refina a altura pela tinta da célula: uma rasura não deve
                # deslocar as outras quatro alternativas da mesma linha.
                half_cell = round(step * 0.4)
                cell = binary[y:y + rh, cx - half_cell:cx + half_cell + 1]
                components, _ = cv2.findContours(cell, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                letters = []
                for contour in components:
                    gx, gy, gw, gh = cv2.boundingRect(contour)
                    # Parênteses são finos; a letra ou a marca central tem
                    # largura e altura suficientes. Nunca consulta answer_key.
                    if gw >= step * .13 and gh >= median_height * .35:
                        letters.append((gw * gh, gx + gw / 2, gy + gh / 2))
                if letters:
                    _, relative_x, _ = max(letters, key=lambda item: item[0])
                    correction = relative_x - half_cell
                    if abs(correction) < step * .22:
                        cx += round(correction)
                        cell = binary[y:y + rh, cx - half_cell:cx + half_cell + 1]
                projection = np.count_nonzero(cell, axis=1)
                active = np.flatnonzero(projection >= max(2, projection.max() * 0.25))
                if len(active) < 5:
                    raise ValueError(f'Não localizei a alternativa {option} da questão {q}.')
                cy = round(y + (active[0] + active[-1]) / 2)
                coordinates[q][option] = (cx, cy)
                radii[q][option] = (round(step * 0.24), round(min(median_height - 2, step * 0.5) * 0.40))
        offset += len(rows)
    if invalid_rows > len(coordinates) * .60:
        raise ValueError(f'Não foi possível validar as cinco alternativas em {invalid_rows}/{len(coordinates)} linhas; orientação ou qualidade insuficiente.')
    return coordinates, radii


def _locate_grid_once(image, question_count, upsampling):
    h, w = image.shape[:2]
    # Normaliza a escala da detecção; 50–60 linhas usam a mesma resolução.
    # Ampliar uma foto muito pequena não recupera detalhes que ela perdeu.
    target_width = CANVAS_WIDTH
    image = cv2.resize(image, (target_width, round(h * target_width / w)),
                       interpolation=cv2.INTER_AREA if w > target_width else upsampling)
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
                groups = _find_text_rows(binary, question_count, check_alignment=False)
                aligned = _rectify_columns(aligned, groups)
                binary = binarize(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY), adaptive)
                groups = _find_text_rows(binary, question_count)
                coordinates, radii = _text_coordinates(binary, groups)
                return aligned, binary, coordinates, radii, 'cartao_impresso'
            except ValueError:
                continue
    rows = (question_count + 1) // 2
    raise ValueError(f'Modelo não reconhecido para {question_count} questões: use duas colunas de {rows} e {question_count // 2} questões (A a E), numeradas de cima para baixo, ou o modelo compatível com quatro marcadores. Confira a quantidade cadastrada e envie a folha inteira e legível.')


def locate_grid(image, question_count=50):
    try:
        return _locate_grid_once(image, question_count, cv2.INTER_CUBIC)
    except ValueError:
        if image.shape[1] >= CANVAS_WIDTH:
            raise
        # A interpolação cúbica pode criar halos em letras pequenas e partir
        # uma linha em vários contornos. Tenta a linear na foto original,
        # mantendo todas as validações de colunas, linhas e alternativas.
        return _locate_grid_once(image, question_count, cv2.INTER_LINEAR)


def measure_density(binary, center, radii):
    cx, cy = center
    rx, ry = radii
    roi = binary[cy - ry:cy + ry + 1, cx - rx:cx + rx + 1]
    if roi.shape != (ry * 2 + 1, rx * 2 + 1):
        raise ValueError('Uma alternativa ficou fora da imagem; a folha pode estar cortada.')
    yy, xx = np.ogrid[-ry:ry + 1, -rx:rx + 1]
    mask = (xx / rx) ** 2 + (yy / ry) ** 2 <= 1
    return float(np.mean(roi[mask]) / 255)


def classify_densities(densities, baselines=None):
    """Compara tinta com caracteres não preenchidos, nunca com o gabarito.

    As letras B/D possuem mais tinta que C. A calibração por coluna/opção
    impede tratar essa diferença tipográfica como marcação do aluno.
    """
    if min(densities.values()) >= .62:
        return 'RAS'
    if baselines is None:
        baseline = min(float(np.mean(sorted(densities.values())[:2])), 0.40)
        baselines = dict.fromkeys(OPTIONS, baseline)
        solid_floor, solid_delta, uncertain_floor, uncertain_delta = .62, .18, .50, .12
    else:
        solid_floor, solid_delta, uncertain_floor, uncertain_delta = .50, .20, .40, .14
    marked = [opt for opt, value in densities.items()
              if value >= solid_floor and value - baselines[opt] >= solid_delta]
    uncertain = [opt for opt, value in densities.items()
                 if value >= uncertain_floor and value - baselines[opt] >= uncertain_delta
                 and opt not in marked]
    if len(marked) > 1:
        return 'RAS'
    if uncertain:
        return 'INC'
    return marked[0] if marked else 'BNK'


def calibrate_baselines(densities, question_count):
    """Referências robustas da própria folha, independentes de uma resposta chave.

    Percentil baixo remove bolhas cheias da referência. O teto deriva das
    duas alternativas menos preenchidas de cada linha: uma coluna com todas
    as respostas A deve continuar reconhecendo A em vez de aprendê-la vazia.
    """
    result = {}
    rows = (question_count + 1) // 2
    for begin, end in ((1, rows), (rows + 1, question_count)):
        group = [densities[str(q)] for q in range(begin, end + 1)]
        empty = np.array([np.mean(sorted(row.values())[:2]) for row in group])
        reference = float(np.median(empty))
        baseline = {option: min(float(np.percentile([row[option] for row in group], 30)), reference + .16)
                    for option in OPTIONS}
        for q, row_empty in zip(range(begin, end + 1), empty):
            shift = float(np.clip(row_empty - reference, -.06, .06))
            result[str(q)] = {option: max(0., value + shift) for option, value in baseline.items()}
    return result


def _save_debug(image, coordinates, radii, densities, answers, key, output_path, baselines=None):
    overlay = image.copy()
    for q, row in coordinates.items():
        answer = answers[q]
        for option, (cx, cy) in row.items():
            rx, ry = radii[q][option]
            color = (170, 170, 170)
            if option == answer:
                color = (0, 175, 0) if not key or key.get(q) == option else (0, 0, 220)
            elif answer == 'RAS' and (densities[q][option] - baselines[q][option] >= .20 if baselines else densities[q][option] >= .62):
                color = (0, 0, 220)
            elif answer == 'INC' and (densities[q][option] - baselines[q][option] >= .14 if baselines else densities[q][option] >= .50):
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


def process_image(file_path, answer_key=None, output_debug_path=None, question_count=None, page_number=None):
    """Retorna marcações e espelho; persistência e notas pertencem ao NestJS."""
    answer_key = answer_key or {}
    try:
        question_count = 50 if question_count is None else question_count
        if isinstance(question_count, bool) or not isinstance(question_count, int) or not 50 <= question_count <= 60:
            raise ValueError('A quantidade deve ser um inteiro entre 50 e 60 questões.')
        image = load_image_or_pdf(file_path, dpi=300, page_number=page_number)
        aligned, binary, coordinates, radii, layout = locate_grid(image, question_count)
        # Integra cobertura suavizada para reduzir mudanças de um único pixel
        # ao redimensionar/fotografar letras finas. Dilatação nunca mede tinta.
        coverage = cv2.GaussianBlur(binary, (3, 3), .6)
        densities = {q: {option: measure_density(coverage, point, radii[q][option])
                         for option, point in row.items()} for q, row in coordinates.items()}
        baselines = calibrate_baselines(densities, question_count) if layout == 'cartao_impresso' else None
        answers = {q: classify_densities(values, baselines[q] if baselines else None) for q, values in densities.items()}
        quality = {}
        for q, values in densities.items():
            base = baselines[q] if baselines else dict.fromkeys(OPTIONS, min(float(np.mean(sorted(values.values())[:2])), .40))
            excess = sorted((values[option] - base[option] for option in OPTIONS), reverse=True)
            quality[q] = {'estado': answers[q], 'margem_tinta': round(excess[0] - excess[1], 4),
                          'excesso_tinta': round(excess[0], 4), 'revisar': answers[q] == 'INC'}
        status = ('ALERTA_REVISAO' if 'INC' in answers.values() else
                  'ALERTA_RASURA' if 'RAS' in answers.values() else 'SUCESSO')
        if output_debug_path:
            _save_debug(aligned, coordinates, radii, densities, answers, answer_key, output_debug_path, baselines)
        return {'respostas_detectadas': answers, 'status': status, 'layout': layout,
                'densidades': densities, 'calibracao': baselines or {}, 'qualidade_questoes': quality, 'debug_image_path': str(output_debug_path) if output_debug_path else None,
                'erro_msg': ''}
    except Exception as exc:
        # O nome/caminho pode conter a matrícula; logs operacionais não o exibem.
        logger.warning('Falha na leitura do cartão: %s', exc)
        return {'respostas_detectadas': {}, 'status': 'ERRO_LEITURA',
                'debug_image_path': None, 'erro_msg': str(exc)}
