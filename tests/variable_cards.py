"""Cartões de teste com linhas reais das fotos, renumerados em duas colunas."""
from pathlib import Path
import cv2
import numpy as np
from omr.engine import locate_grid, _find_text_rows
from omr.pdf_loader import load_image_or_pdf

PHOTO_KEY = dict(enumerate('CBDDEAABCDEEAAABCCDBBBCCDABBCBCBBCBBAABCCBCCCBCBBC', 1))


def printed_card(count, answers=None, output=None):
    source = load_image_or_pdf(Path(__file__).parent / 'fixtures/cartao_contraste.jpeg')
    image, binary, _, _, _ = locate_grid(source)
    groups = _find_text_rows(binary)
    pitch = 36
    first_y = 450
    rows = (count + 1) // 2
    canvas = np.full((first_y + rows * pitch + 140, 1000, 3), 255, dtype=np.uint8)
    canvas[:415] = image[:415]
    answers = answers or {str(q): 'ABCDE'[(q - 1) % 5] for q in range(1, count + 1)}
    for q in range(1, count + 1):
        column, index = (0, q - 1) if q <= rows else (1, q - rows - 1)
        answer = answers[str(q)]
        selected = next(i for i in range(25) if PHOTO_KEY[i + 1] == (answer if answer in 'ABCDE' else 'A'))
        x, y, rw, rh, _ = groups[0][selected]
        patch = image[y - 2:y + rh + 2, x - 18:x + rw + 2].copy()
        # Limpa apenas o número; preserva letras e marcações da foto.
        patch[:, :51] = 255
        label = f'{q:02d}.'
        width = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)[0][0]
        cv2.putText(patch, label, (51 - width, rh - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (20, 20, 20), 1, cv2.LINE_AA)
        target_y = first_y + index * pitch
        target_x = x + column * 413
        canvas[target_y:target_y + patch.shape[0], target_x - 18:target_x + rw + 2] = patch
    if output:
        if str(output).lower().endswith('.pdf'):
            from PIL import Image
            Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)).save(output, 'PDF', resolution=150)
        else:
            cv2.imwrite(str(output), canvas)
    return canvas, answers


if __name__ == '__main__':
    import sys
    printed_card(int(sys.argv[1]), output=sys.argv[2])
