import io
import tempfile
from pathlib import Path
from contextlib import redirect_stdout

import cv2
import numpy as np
from PIL import Image
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from omr.engine import process_image, classify_densities, detect_fiducial_markers
from omr.pdf_loader import load_image_or_pdf
from sample_sheets import generate_answer_sheet
from variable_cards import printed_card

FIXTURES = Path(__file__).parent / 'fixtures'
# Transcrição visual das 50 respostas das imagens fornecidas pelo usuário.
PHOTO_ANSWERS = dict(enumerate('CBDDEAABCDEEAAABCCDBBBCCDABBCBCBBCBBAABCCBCCCBCBBC', 1))
PHOTO_KEY = {str(q): answer for q, answer in PHOTO_ANSWERS.items()}
PATTERN_KEY = {str(q): 'ABCDE'[(q - 1) % 5] for q in range(1, 51)}


class OMRTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def assert_photo_reading(self, path):
        result = process_image(path, PHOTO_KEY)
        self.assertEqual(result['status'], 'SUCESSO', result.get('erro_msg'))
        self.assertEqual(result['respostas_detectadas'], PHOTO_KEY)
        self.assertNotIn('nota_percentual', result)
        self.assertNotIn('INC', result['respostas_detectadas'].values())

    def test_three_provided_photos_match_visual_transcription(self):
        for path in FIXTURES.glob('*.jpeg'):
            with self.subTest(photo=path.name):
                self.assert_photo_reading(path)

    def test_skew_shadow_quarter_turns_and_mild_perspective(self):
        image = load_image_or_pdf(FIXTURES / 'cartao_sombra.jpeg')
        h, w = image.shape[:2]
        variants = {}
        for angle in (-4, -2, 2, 4):
            variants[f'skew{angle}'] = cv2.warpAffine(
                image, cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1),
                (w, h), borderValue=(255, 255, 255),
            )
        for rotation in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE):
            variants[f'turn{rotation}'] = cv2.rotate(image, rotation)
        variants['shadow'] = (image * np.linspace(0.5, 1, w)[None, :, None]).astype('uint8')
        transform = cv2.getPerspectiveTransform(
            np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]]),
            np.float32([[45, 25], [w - 25, 0], [w - 1, h - 20], [0, h - 1]]),
        )
        variants['perspective'] = cv2.warpPerspective(image, transform, (w, h), borderValue=(255, 255, 255))
        for name, variant in variants.items():
            with self.subTest(variant=name):
                path = self.directory / f'{name}.png'
                cv2.imwrite(str(path), variant)
                self.assert_photo_reading(path)

    def test_image_formats_and_white_transparency(self):
        with Image.open(FIXTURES / 'cartao_sombra.jpeg') as source:
            for extension, format_name in [('jpg', 'JPEG'), ('png', 'PNG'), ('webp', 'WEBP'), ('bmp', 'BMP'), ('tiff', 'TIFF')]:
                with self.subTest(format=format_name):
                    path = self.directory / f'card.{extension}'
                    source.save(path, format_name)
                    self.assert_photo_reading(path)
            rgba = source.convert('RGBA')
            alpha = np.where(np.min(np.asarray(rgba)[:, :, :3], axis=2) > 230, 0, 255).astype('uint8')
            rgba.putalpha(Image.fromarray(alpha))
            path = self.directory / 'transparent.png'
            rgba.save(path)
            self.assert_photo_reading(path)

    def test_exif_orientation_is_applied(self):
        with Image.open(FIXTURES / 'cartao_sombra.jpeg') as source:
            rotated = source.transpose(Image.Transpose.ROTATE_90)
            exif = Image.Exif()
            exif[274] = 6
            path = self.directory / 'phone.jpg'
            rotated.save(path, quality=95, exif=exif)
            image = load_image_or_pdf(path)
            self.assertEqual(image.shape[:2], (source.height, source.width))
            self.assert_photo_reading(path)

    def test_synthetic_pdf_blank_double_and_all_five_marked(self):
        answers = dict(PATTERN_KEY)
        answers['10'], answers['20'] = 'RAS', 'BNK'
        path = self.directory / '123.pdf'
        with redirect_stdout(io.StringIO()):
            generate_answer_sheet('123', answers, str(path))
        result = process_image(path, PATTERN_KEY)
        self.assertEqual(result['respostas_detectadas'], answers)
        self.assertEqual(list(result['respostas_detectadas'].values()).count('RAS'), 1)
        self.assertEqual(list(result['respostas_detectadas'].values()).count('BNK'), 1)
        self.assertEqual(classify_densities(dict.fromkeys('ABCDE', 1.0)), 'RAS')

    def test_interior_measurement_does_not_count_unfilled_bubble_outlines(self):
        path = self.directory / 'blank.pdf'
        with redirect_stdout(io.StringIO()):
            generate_answer_sheet('123', {}, str(path))
        result = process_image(path, PATTERN_KEY)
        self.assertEqual(result['status'], 'SUCESSO')
        self.assertEqual(list(result['respostas_detectadas'].values()).count('BNK'), 50)
        self.assertNotIn('RAS', result['respostas_detectadas'].values())

    def test_uncertain_ink_is_not_a_blank_or_confirmed_answer(self):
        self.assertEqual(classify_densities(dict(zip('ABCDE', [.25, .55, .3, .3, .3]))), 'INC')
        self.assertEqual(classify_densities(dict(zip('ABCDE', [.95, .55, .3, .3, .3]))), 'INC')

    def test_unknown_page_fails_instead_of_reporting_fifty_blanks(self):
        image = np.full((1400, 1000, 3), 255, dtype='uint8')
        cv2.putText(image, 'Documento sem gabarito', (100, 200), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
        path = self.directory / 'unknown.png'
        cv2.imwrite(str(path), image)
        result = process_image(path, PATTERN_KEY)
        self.assertEqual(result['status'], 'ERRO_LEITURA')
        self.assertEqual(result['respostas_detectadas'], {})
        self.assertNotIn('total_brancos', result)
        self.assertIsNone(result['debug_image_path'])
        self.assertIn('Modelo não reconhecido', result['erro_msg'])
        with self.assertRaises(ValueError):
            detect_fiducial_markers(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))

    def test_debug_image_preserves_original_page(self):
        output = self.directory / 'debug.png'
        result = process_image(FIXTURES / 'cartao_sombra.jpeg', PHOTO_KEY, output)
        self.assertEqual(result['status'], 'SUCESSO')
        self.assertTrue(output.is_file())
        self.assertGreater(cv2.imread(str(output)).shape[0], 1400)

    def test_variable_printed_cards_include_all_questions_and_three_digit_labels(self):
        for count in (10, 25, 49, 60, 61, 90, 180, 300):
            with self.subTest(count=count):
                path = self.directory / f'printed-{count}.png'
                _, key = printed_card(count, output=path)
                result = process_image(path, key, question_count=count)
                self.assertEqual(result['status'], 'SUCESSO', result['erro_msg'])
                self.assertEqual(result['respostas_detectadas'], key)
                self.assertEqual(len(result['respostas_detectadas']), count)

    def test_variable_card_deskew_and_pdf(self):
        image, key = printed_card(60)
        h, w = image.shape[:2]
        for angle in (-3, 3):
            path = self.directory / f'sixty-{angle}.png'
            rotated = cv2.warpAffine(image, cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1), (w, h), borderValue=(255, 255, 255))
            cv2.imwrite(str(path), rotated)
            result = process_image(path, key)
            self.assertEqual(result['respostas_detectadas'], key, result['erro_msg'])
        path = self.directory / 'sixty.pdf'
        printed_card(60, output=path)
        result = process_image(path, key)
        self.assertEqual(result['respostas_detectadas'], key, result['erro_msg'])

    def test_denser_cards_with_sixty_ninety_and_180_questions(self):
        for count in (60, 90, 180):
            with self.subTest(count=count):
                image, key = printed_card(count)
                image = cv2.resize(image, (1000, 1419), interpolation=cv2.INTER_AREA)
                path = self.directory / f'dense-{count}.png'
                cv2.imwrite(str(path), image)
                result = process_image(path, key)
                self.assertEqual(result['respostas_detectadas'], key, result['erro_msg'])

    def test_wrong_count_or_missing_rows_never_silently_truncates(self):
        path = self.directory / 'sixty.png'
        image, key = printed_card(60, output=path)
        for count in (50, 58, 59, 61, 62, 90):
            with self.subTest(count=count):
                result = process_image(path, question_count=count)
                self.assertEqual(result['status'], 'ERRO_LEITURA')
                self.assertEqual(result['respostas_detectadas'], {})
        # Retira uma linha do meio da coluna direita.
        image[450 + 12 * 36:450 + 13 * 36, 490:] = 255
        cv2.imwrite(str(path), image)
        self.assertEqual(process_image(path, key)['status'], 'ERRO_LEITURA')

    def test_variable_markers_preserve_blank_double_and_last_question(self):
        for count in (60, 61, 90, 180):
            with self.subTest(count=count):
                key = {str(q): 'ABCDE'[(q - 1) % 5] for q in range(1, count + 1)}
                answers = {**key, '10': 'RAS', str(count - 1): 'BNK'}
                path = self.directory / f'markers-{count}.pdf'
                with redirect_stdout(io.StringIO()):
                    generate_answer_sheet('123', answers, str(path), question_count=count)
                result = process_image(path, key)
                self.assertEqual(result['respostas_detectadas'], answers, result['erro_msg'])

    def test_invalid_question_count_is_rejected(self):
        for count in (0, 1, 5, 301, 60.5, True, '60'):
            self.assertEqual(process_image(FIXTURES / 'cartao_sombra.jpeg', question_count=count)['status'], 'ERRO_LEITURA')
