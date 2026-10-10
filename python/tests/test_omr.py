"""Testes de leitura, nunca de repetição de uma única chave/foto."""
import io
import json
import sys
import tempfile
from pathlib import Path
from contextlib import redirect_stdout
import unittest

import cv2
import numpy as np
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from omr.engine import process_image, classify_densities, detect_fiducial_markers
from omr.pdf_loader import load_image_or_pdf
from omr.validation import validate_file
from sample_sheets import generate_answer_sheet
from variable_cards import printed_card, degrade, FONT_CANDIDATES
from benchmark import cases

FIXTURES = Path(__file__).parent / 'fixtures'
LOCAL = Path(__file__).parent / 'local_fixtures'
# Transcrições VISUAIS das fotos; nenhum destes valores pertence ao engine.
PHOTO_KEY = dict(zip(map(str, range(1, 51)), 'CBDDEAABCDEEAAABCCDBBBCCDABBCBCBBCBBAABCCBCCCBCBBC'))
PHOTO60_KEY = dict(zip(map(str, range(1, 61)), 'BADCBDAEDCEDBEBDABADCDEABABCBABCBABCDCBABCDEDCBAEDEDCDEDCBCD'))
SPARSE60_KEY = {**PHOTO60_KEY, **dict.fromkeys(map(str, [2, 3, 5, 6, 8, 10, 11, 12]), 'BNK')}
DOUBLE60_KEY = {**PHOTO60_KEY, **dict.fromkeys(('1', '16', '27'), 'RAS')}
PATTERN_KEY = {str(q): 'ABCDE'[(q - 1) % 5] for q in range(1, 51)}


class OMRTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def read_card(self, image, count, name='card.png', key=None):
        path = self.directory / name
        cv2.imwrite(str(path), image)
        return process_image(path, answer_key=key, question_count=count)

    @unittest.skipUnless((FIXTURES / 'cartao_sombra.jpeg').exists(), 'Fotos pessoais ficam somente no ambiente local.')
    def test_three_real_fifty_cards_match_visual_transcription(self):
        for path in FIXTURES.glob('*.jpeg'):
            with self.subTest(photo=path.name):
                r = process_image(path, question_count=50)
                self.assertEqual(r['respostas_detectadas'], PHOTO_KEY, r['erro_msg'])
                self.assertEqual(r['status'], 'SUCESSO')

    @unittest.skipUnless((LOCAL / '60_branco.png').exists(), 'Fotos pessoais novas ficam somente no ambiente local.')
    def test_seven_real_sixty_cards_include_empty_sparse_light_and_doubles(self):
        targets = {'60_branco.png': dict.fromkeys(map(str, range(1, 61)), 'BNK'),
                   '60_cheio.png': PHOTO60_KEY, '60_duplas_1.png': DOUBLE60_KEY, '60_duplas_2.png': DOUBLE60_KEY,
                   '60_claro_1.png': SPARSE60_KEY, '60_claro_2.png': SPARSE60_KEY, '60_claro_3.png': SPARSE60_KEY}
        for name, truth in targets.items():
            with self.subTest(photo=name):
                r = process_image(LOCAL / name, question_count=60)
                self.assertEqual(r['respostas_detectadas'], truth, r['erro_msg'])

    def test_independent_randomized_benchmark_with_explicit_ground_truth(self):
        # Fonte vetorial, marcações e degradações são produzidas sem importar
        # o leitor, fotos, answer_key ou coordenadas de get_grid_coordinates.
        for name, count, truth, variant, options in cases():
            with self.subTest(case=name):
                image, _ = printed_card(count, truth, **options)
                r = self.read_card(degrade(image, variant), count)
                detected = r['respostas_detectadas']
                self.assertEqual(len(detected), count, r['erro_msg'])
                for q, answer in truth.items():
                    # Revisão é abstenção, nunca um chute de alternativa. A
                    # métrica separa revisões de respostas erradas e mantém
                    # o ground truth original para auditoria.
                    if answer in 'ABCDE' and detected[q] == 'INC':
                        self.assertTrue(r['qualidade_questoes'][q]['revisar'])
                    else:
                        self.assertEqual(detected[q], answer)

    def test_font_portability_keeps_labels_separate_and_truth_independent(self):
        fonts = ['builtin', *[path for path in FONT_CANDIDATES if Path(path).is_file()]]
        for font_path in fonts:
            for count in (50, 60):
                for size, requested_step in ((19, 38), (21, 43), (27, 55)):
                    with self.subTest(font=font_path, count=count, size=size):
                        rng = np.random.default_rng(count + size)
                        truth = {str(q): str(rng.choice(list('ABCDE'))) for q in range(1, count + 1)}
                        truth['8'], truth['17'] = 'BNK', 'RAS'
                        image, _ = printed_card(count, truth, font_size=size, step=requested_step, font_path=font_path)
                        result = self.read_card(image, count)
                        self.assertEqual(result['respostas_detectadas'], truth, result['erro_msg'])

    def test_empty_cards_keep_printed_letters_unmarked_across_fonts(self):
        fonts = ['builtin', *[path for path in FONT_CANDIDATES if Path(path).is_file()]]
        for font_path in fonts:
            for count in (50, 60):
                with self.subTest(font=font_path, count=count):
                    truth = dict.fromkeys(map(str, range(1, count + 1)), 'BNK')
                    image, _ = printed_card(count, truth, font_path=font_path)
                    result = self.read_card(image, count)
                    self.assertEqual(result['respostas_detectadas'], truth, result['erro_msg'])
                    self.assertEqual(result['status'], 'SUCESSO')

    def test_every_integer_question_count_from_fifty_to_sixty(self):
        for count in range(50, 61):
            with self.subTest(count=count):
                image, truth = printed_card(count)
                r = self.read_card(image, count)
                self.assertEqual(r['respostas_detectadas'], truth, r['erro_msg'])

    def test_answer_key_never_changes_geometry_density_or_answers(self):
        rng = np.random.default_rng(923)
        truth = {str(q): str(rng.choice(list('ABCDE'))) for q in range(1, 61)}
        image, _ = printed_card(60, truth)
        opposite = {q: 'ABCDE'[('ABCDE'.index(a) + 2) % 5] for q, a in truth.items()}
        without = self.read_card(image, 60)
        correct = self.read_card(image, 60, key=truth)
        wrong = self.read_card(image, 60, key=opposite)
        self.assertEqual(without['respostas_detectadas'], truth)
        for field in ('respostas_detectadas', 'densidades', 'calibracao', 'qualidade_questoes', 'layout', 'status'):
            self.assertEqual(without[field], correct[field])
            self.assertEqual(without[field], wrong[field])
        self.assertNotIn('nota_percentual', correct)

    def test_answer_key_length_does_not_define_question_count(self):
        image, truth = printed_card(50)
        path = self.directory / 'default.png'
        cv2.imwrite(str(path), image)
        unrelated_key = dict.fromkeys(map(str, range(1, 61)), 'E')
        self.assertEqual(process_image(path, unrelated_key)['respostas_detectadas'], truth)

    def test_debug_colors_may_change_but_never_reading(self):
        path = self.directory / 'input.png'
        image, truth = printed_card(50)
        cv2.imwrite(str(path), image)
        r = process_image(path, truth, self.directory / 'debug.png')
        self.assertEqual(r['respostas_detectadas'], truth)
        self.assertTrue((self.directory / 'debug.png').exists())
        self.assertGreater(cv2.imread(str(self.directory / 'debug.png')).shape[0], image.shape[0] * .8)

    def test_pdfs_decode_without_external_poppler_and_keep_marks(self):
        truth = {**PATTERN_KEY, '10': 'RAS', '20': 'BNK'}
        for layout in ('printed', 'markers'):
            path = self.directory / f'{layout}.pdf'
            if layout == 'printed':
                printed_card(50, truth, output=path)
            else:
                with redirect_stdout(io.StringIO()):
                    generate_answer_sheet('TESTE-SINTETICO', truth, str(path))
            r = process_image(path, question_count=50)
            self.assertEqual(r['respostas_detectadas'], truth, r['erro_msg'])

    def test_markers_reject_unrelated_corners_and_verify_bubbles(self):
        image = np.full((1400, 1000, 3), 255, dtype='uint8')
        for x, y in ((50, 50), (950, 50), (950, 1350), (50, 1350)):
            cv2.rectangle(image, (x-18, y-18), (x+18, y+18), (0, 0, 0), -1)
        r = self.read_card(image, 50)
        self.assertEqual(r['status'], 'ERRO_LEITURA')
        self.assertEqual(r['respostas_detectadas'], {})

    def test_image_formats_and_white_transparency(self):
        image, truth = printed_card(50)
        source = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
        for extension, fmt in [('jpg', 'JPEG'), ('png', 'PNG'), ('webp', 'WEBP'), ('bmp', 'BMP'), ('tiff', 'TIFF')]:
            with self.subTest(format=fmt):
                path = self.directory / f'card.{extension}'
                source.save(path, fmt)
                self.assertEqual(process_image(path)['respostas_detectadas'], truth)
        rgba = source.convert('RGBA')
        alpha = np.where(np.min(np.asarray(rgba)[:, :, :3], axis=2) > 230, 0, 255).astype('uint8')
        rgba.putalpha(Image.fromarray(alpha))
        path = self.directory / 'transparent.png'
        rgba.save(path)
        self.assertEqual(process_image(path)['respostas_detectadas'], truth)

    def test_exif_orientation_and_physical_quarter_turns(self):
        image, truth = printed_card(50)
        for rotation in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE):
            self.assertEqual(self.read_card(cv2.rotate(image, rotation), 50)['respostas_detectadas'], truth)
        source = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
        rotated = source.transpose(Image.Transpose.ROTATE_90)
        exif = Image.Exif(); exif[274] = 6
        path = self.directory / 'phone.jpg'
        rotated.save(path, quality=95, exif=exif)
        self.assertEqual(load_image_or_pdf(path).shape[:2], (source.height, source.width))
        self.assertEqual(process_image(path)['respostas_detectadas'], truth)

    def test_crop_unknown_page_wrong_total_and_missing_row_do_not_turn_into_blanks(self):
        image, _ = printed_card(60)
        r = self.read_card(image, 50)
        self.assertEqual(r['status'], 'ERRO_LEITURA')
        image[530 + 12 * 35:530 + 13 * 35, 550:] = 255
        self.assertEqual(self.read_card(image, 60)['status'], 'ERRO_LEITURA')
        unknown = np.full((1400, 1000, 3), 255, dtype='uint8')
        cv2.putText(unknown, 'Documento sem respostas', (100, 200), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
        r = self.read_card(unknown, 50)
        self.assertEqual(r['respostas_detectadas'], {})
        self.assertIsNone(r['debug_image_path'])
        with self.assertRaises(ValueError):
            detect_fiducial_markers(cv2.cvtColor(unknown, cv2.COLOR_BGR2GRAY))

    def test_uncertain_ink_and_all_five_marks_are_not_guessed_from_key(self):
        self.assertEqual(classify_densities(dict(zip('ABCDE', [.25, .55, .3, .3, .3]))), 'INC')
        self.assertEqual(classify_densities(dict(zip('ABCDE', [.95, .55, .3, .3, .3]))), 'INC')
        self.assertEqual(classify_densities(dict.fromkeys('ABCDE', 1.0)), 'RAS')

    def test_invalid_total_is_rejected_before_decoding(self):
        for count in (0, 1, 10, 49, 61, 90, 120, 300, 60.5, True, '60'):
            with self.subTest(count=count):
                r = process_image('nonexistent.png', question_count=count)
                self.assertEqual(r['status'], 'ERRO_LEITURA')
                self.assertIn('entre 50 e 60', r['erro_msg'])

    def test_filename_extension_must_match_real_image_and_limits(self):
        path = self.directory / 'bad.png'
        path.write_bytes(b'%PDF-1.7')
        with self.assertRaises(ValueError):
            validate_file(path)
