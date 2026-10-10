"""Ensaio reprodutível sem PII. Cada PNG possui um JSON de verdade independente.

Uso: PYTHONPATH=python ./venv/bin/python python/tests/benchmark.py [diretório]
Não calibra limiares com a chave: as chaves só são usadas DEPOIS da leitura.
"""
from pathlib import Path
import json
import sys
import time
import cv2
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from omr.engine import process_image
from variable_cards import printed_card, degrade


def cases():
    variants = ('base', 'rotation-4', 'rotation4', 'perspective', 'shadow', 'noise', 'blur', 'blue')
    for count in (50, 55, 60):
        for seed in (19, 71, 211):
            rng = np.random.default_rng(seed)
            truth = {str(q): str(rng.choice(list('ABCDE'))) for q in range(1, count + 1)}
            truth['8'], truth['17'], truth[str(count)] = 'BNK', 'RAS', 'BNK'
            for variant in variants:
                yield f'{count}-seed{seed}-{variant}', count, truth, variant, {'seed': seed}
        for state in ('BNK', 'A', 'B', 'C', 'D', 'E', 'RAS'):
            truth = dict.fromkeys((str(q) for q in range(1, count + 1)), state)
            for variant in ('base', 'shadow', 'perspective'):
                yield f'{count}-all{state}-{variant}', count, truth, variant, {'seed': 401}
        for font, step in ((19, 38), (24, 49), (27, 55)):
            rng = np.random.default_rng(font)
            truth = {str(q): str(rng.choice(list('ABCDE'))) for q in range(1, count + 1)}
            yield f'{count}-font{font}', count, truth, 'base', {'font_size': font, 'step': step}
        for first_y, margin in ((350, (110, 640)), (650, (145, 660))):
            rng = np.random.default_rng(first_y)
            truth = {str(q): str(rng.choice(list('ABCDE'))) for q in range(1, count + 1)}
            yield f'{count}-position{first_y}', count, truth, 'base', {'first_y': first_y, 'margins': margin}
        rng = np.random.default_rng(123)
        truth = {str(q): str(rng.choice(list('ABCDE'))) for q in range(1, count + 1)}
        yield f'{count}-scribbles', count, truth, 'base', {'mark_style': 'scribble', 'seed': 432}
    # INC is deliberately partial ink at one known geometry, not asserted as
    # a universal semantic label for any faint/erased mark in unknown photos.
    truth = {str(q): 'INC' if q == 30 else 'ABCDE'[q % 5] for q in range(1, 61)}
    yield '60-partial-ink', 60, truth, 'base', {'seed': 312}


def run(output):
    output.mkdir(parents=True, exist_ok=True)
    records, confusions = [], {}
    review_count = 0
    started = time.monotonic()
    for name, count, truth, variant, options in cases():
        image, _ = printed_card(count, truth, **options)
        image = degrade(image, variant)
        path = output / f'{name}.png'
        cv2.imwrite(str(path), image)
        (output / f'{name}.truth.json').write_text(json.dumps({'question_count': count, 'answers': truth}, indent=2))
        result = process_image(path, question_count=count)
        detected = result['respostas_detectadas']
        mismatches = []
        for q, answer in truth.items():
            actual = detected.get(q, 'ERRO_LEITURA')
            if actual != answer:
                abstention = actual == 'INC' and answer in 'ABCDE'
                review_count += int(abstention)
                mismatches.append({'questao': q, 'truth': answer, 'detected': actual, 'abstention': abstention})
            pair = f'{answer}->{actual}'
            confusions[pair] = confusions.get(pair, 0) + 1
        records.append({'case': name, 'questions': count, 'status': result['status'], 'mismatches': mismatches,
                        'reading_error': result['erro_msg']})
    total = sum(r['questions'] for r in records)
    wrong = sum(len(r['mismatches']) for r in records)
    summary = {'engine': 'printed-geometry-calibrated-v2', 'cases': len(records), 'questions': total,
               'correct_labels': total - wrong, 'incorrect_labels': wrong - review_count, 'review_abstentions': review_count, 'exact_cards': sum(not r['mismatches'] for r in records),
               'label_accuracy': (total - wrong) / total, 'confirmed_label_accuracy': (total - wrong) / (total - review_count), 'seconds': round(time.monotonic() - started, 2),
               'confusion_counts': confusions, 'records': records,
               'scope': 'Synthetic measured fixtures; this result is not a population accuracy estimate.'}
    (output / 'metrics.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    montage = Image.new('RGB', (1200, 1060), '#edf1f6')
    draw = ImageDraw.Draw(montage)
    draw.text((20, 15), f"OMR: {len(records)} scenarios / {total} answers / {wrong} differences", fill='#172b4d')
    samples = [r for r in records if r['case'] in ('50-seed19-base', '50-seed71-shadow', '60-seed211-perspective', '60-allBNK-base', '60-allRAS-base', '60-partial-ink')]
    for index, record in enumerate(samples):
        thumb = Image.open(output / f"{record['case']}.png")
        thumb.thumbnail((365, 450))
        x, y = 20 + (index % 3) * 395, 55 + (index // 3) * 500
        montage.paste(thumb, (x, y))
        draw.text((x, y + 456), record['case'], fill='#172b4d')
    montage.save(output / 'montage.png')
    print(json.dumps({k: summary[k] for k in ('cases', 'questions', 'correct_labels', 'incorrect_labels', 'review_abstentions', 'exact_cards', 'label_accuracy', 'confirmed_label_accuracy', 'seconds')}, indent=2))
    return summary


if __name__ == '__main__':
    result = run(Path(sys.argv[1]) if len(sys.argv) > 1 else Path('artifacts/omr-benchmark'))
    sys.exit(bool(result['incorrect_labels']))
