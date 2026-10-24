"""Gera cartões independentes com verdade conhecida, sem dados de alunos reais."""
from pathlib import Path
import json
import sys
import random
from PIL import Image, ImageDraw
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python/tests'))
from variable_cards import printed_card, _font, degrade

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
rng = random.Random(704)
truth = {}
images = []
for index, count in enumerate((50, 50, 60)):
    key = {str(q): rng.choice('ABCDE') for q in range(1, count + 1)}
    answers = dict(key)
    if index == 1:
        answers.update({'2': 'BNK', '3': 'RAS', '4': 'ABCDE'[('ABCDE'.index(key['4']) + 1) % 5]})
    image, _ = printed_card(count, answers, seed=index+100)
    image = Image.fromarray(image[:, :, ::-1]); draw = ImageDraw.Draw(image)
    draw.rectangle((70, 135, 1160, 205), fill='white')
    enrollment = '00012' + str(index + 3)
    draw.text((90, 145), 'Matricula: ' + enrollment, font=_font(36), fill=(15, 15, 15))
    image.save(out / f'card-{index+1}.png')
    images.append(image)
    truth[enrollment] = {'count': count, 'key': key, 'answers': answers}
images[0].save(out/'two-pages.pdf', 'PDF', resolution=150, save_all=True, append_images=[images[1]])
images[2].save(out/'sixty.pdf', 'PDF', resolution=150)
(out/'truth.json').write_text(json.dumps(truth))
print('Gerados 3 cartões e 2 PDFs, com matrículas fictícias e respostas conhecidas.')
