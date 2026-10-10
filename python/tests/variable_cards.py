"""Cartões sintéticos independentes: fontes vetoriais, tinta e truth explícito.

Não recorta fotos nem importa o localizador do leitor. O mesmo renderizador é
usado nos testes de ponta a ponta do Nest; variações usam sementes reproduzíveis.
"""
from pathlib import Path
import json
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OPTIONS = 'ABCDE'
FONT_CANDIDATES = [
    '/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]


def _font(size, font_path=None):
    for candidate in [font_path, *FONT_CANDIDATES]:
        if candidate and Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


def printed_card(count, answers=None, output=None, *, seed=1, size=(1200, 1700),
                 font_size=21, step=43, pitch=None, first_y=530, margins=(120, 650),
                 mark_style='solid', font_path=None):
    if not 50 <= count <= 60:
        raise ValueError('Os cartões suportados têm de 50 a 60 questões.')
    rng = np.random.default_rng(seed)
    rows = (count + 1) // 2
    pitch = pitch or min(39, (size[1] - first_y - 100) // rows)
    answers = answers if answers is not None else {str(q): OPTIONS[(q - 1) % 5] for q in range(1, count + 1)}
    answers = {str(q): answers.get(str(q), 'BNK') for q in range(1, count + 1)}
    image = Image.new('RGB', size, 'white')
    draw = ImageDraw.Draw(image)
    font, heading = _font(font_size, font_path), _font(28, font_path)
    draw.text((90, round(first_y * .18)), 'CARTAO DE RESPOSTAS — ENSAIO SINTETICO', font=heading, fill=(30, 30, 30))
    draw.text((90, round(first_y * .30)), 'MATRICULA: TESTE-SEM-DADOS-PESSOAIS', font=font, fill=(30, 30, 30))
    draw.text((90, round(first_y * .48)), 'Marque apenas UMA alternativa. Cartao de teste deterministico.', font=font, fill=(30, 30, 30))
    draw.text((90, round(first_y * .64)), 'Exemplo correto: ( A ) ( B ) ( C ) ( D ) ( E )', font=font, fill=(30, 30, 30))
    for column, x in enumerate(margins):
        begin, end = (1, rows) if column == 0 else (rows + 1, count)
        draw.text((x - 42, first_y - 45), f'QUESTOES {begin:02d} A {end}', font=font, fill=(30, 30, 30))
    for q in range(1, count + 1):
        col, index = (0, q - 1) if q <= rows else (1, q - rows - 1)
        y = first_y + index * pitch
        cx = margins[col]
        number_width = draw.textlength(f'{q:02d}.', font=font)
        option_width = draw.textlength('( A )', font=font)
        draw.text((cx - option_width / 2 - number_width - 8, y), f'{q:02d}.', font=font, fill=(35, 35, 35))
        for i, option in enumerate(OPTIONS):
            center_x = cx + i * step
            label = f'( {option} )'
            bbox = draw.textbbox((0, 0), label, font=font)
            draw.text((center_x - (bbox[2] - bbox[0]) / 2, y), label, font=font, fill=(40, 40, 40))
            state = answers[str(q)]
            if option == state or state == 'RAS' and option in 'AE':
                center_y = y + (bbox[1] + bbox[3]) / 2
                radius_x, radius_y = font_size * .41, font_size * .30
                if mark_style == 'solid':
                    draw.ellipse((center_x - radius_x, center_y - radius_y,
                                  center_x + radius_x, center_y + radius_y), fill=(18, 18, 18))
                else:
                    # Rabiscos cruzados, diferentes de uma bolha perfeita.
                    for _ in range(18):
                        dx = rng.uniform(-radius_x, radius_x, 2)
                        dy = rng.uniform(-radius_y, radius_y, 2)
                        draw.line((center_x + dx[0], center_y + dy[0], center_x + dx[1], center_y + dy[1]), fill=(65, 65, 65), width=2)
            elif state == 'INC' and option == 'B':
                # Tinta parcial deliberadamente ambígua: uma faixa, não resposta válida.
                cy = y + (bbox[1] + bbox[3]) / 2
                draw.line((center_x - font_size * .38, cy, center_x + font_size * .38, cy), fill=(65, 65, 65), width=max(3, round(font_size * .15)))
    canvas = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
    if output:
        destination = Path(output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.suffix.lower() == '.pdf':
            image.save(destination, 'PDF', resolution=150)
        else:
            cv2.imwrite(str(destination), canvas)
    return canvas, answers


def degrade(image, variant, seed=1):
    """Aplica condições de captura, nunca altera o truth das marcações."""
    rng = np.random.default_rng(seed)
    h, w = image.shape[:2]
    if variant.startswith('rotation'):
        angle = float(variant.removeprefix('rotation'))
        return cv2.warpAffine(image, cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1), (w, h), borderValue=(255, 255, 255))
    if variant == 'perspective':
        matrix = cv2.getPerspectiveTransform(np.float32([[0, 0], [w-1, 0], [w-1, h-1], [0, h-1]]),
                                             np.float32([[75, 40], [w-65, 0], [w-1, h-50], [0, h-1]]))
        return cv2.warpPerspective(image, matrix, (w, h), borderValue=(255, 255, 255))
    if variant == 'shadow':
        gain = np.linspace(.45, 1, w)[None, :, None]
        return (image * gain).astype(np.uint8)
    if variant == 'noise':
        return np.clip(image.astype(float) + rng.normal(0, 6, image.shape), 0, 255).astype(np.uint8)
    if variant == 'blur':
        return cv2.GaussianBlur(image, (3, 3), .8)
    if variant == 'blue':
        out = image.copy()
        ink = out.min(axis=2) < 100
        out[ink] = (100, 35, 25)
        return out
    return image.copy()


if __name__ == '__main__':
    import sys
    _, truth = printed_card(int(sys.argv[1]), output=sys.argv[2])
    if len(sys.argv) > 3:
        Path(sys.argv[3]).write_text(json.dumps(truth, ensure_ascii=False, indent=2))
