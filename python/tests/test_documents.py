"""PDFs individuais/em lote e identificação, com dados exclusivamente fictícios."""
from io import BytesIO
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api import omr as remote
from omr.engine import process_image
from omr.identity import (extract_image_identity, extract_page_identity, identity_result,
                          inspect_document, labelled_candidates, _ocr_candidates)
from omr.pdf_loader import document_info, load_image_or_pdf
from variable_cards import printed_card, _font


def digital_pdf(path, texts):
    """PDF vetorial mínimo com rótulos variados, sem bibliotecas extras/arquivos reais."""
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']
    kids = []
    for text in texts:
        page_id = len(objects) + 1
        stream_id = page_id + 1
        kids.append(f'{page_id} 0 R'.encode())
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>'.encode())
        commands = [b'BT /F1 16 Tf 70 740 Td']
        for line in text.split('\n'):
            escaped = line.encode('cp1252').replace(b'\\', b'\\\\').replace(b'(', b'\\(').replace(b')', b'\\)')
            commands.append(b'(' + escaped + b') Tj 0 -25 Td')
        stream = b'\n'.join([*commands, b'ET'])
        objects.append(b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream')
    objects[1] = b'<< /Type /Pages /Count ' + str(len(kids)).encode() + b' /Kids [' + b' '.join(kids) + b'] >>'
    output, offsets = bytearray(b'%PDF-1.4\n'), [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(output)
    output.extend(f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        output.extend(f'{offset:010d} 00000 n \n'.encode())
    output.extend(f'trailer << /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    Path(path).write_bytes(output)


def identified_card(count, matricula, answers=None):
    image, truth = printed_card(count, answers)
    image = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(image)
    draw.rectangle((80, 150, 1100, 199), fill='white')
    draw.text((90, 157), 'Matrícula: ' + matricula, font=_font(24), fill='black')
    return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR), truth


class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def test_labels_preserve_leading_zeros_and_ignore_dates_and_unlabelled_numbers(self):
        values, labelled = labelled_candidates('Dia 01 - Data 09/10/2026\nMatrícula: 0001234567 Curso: ENSAIO\nAluno 1234567890')
        self.assertEqual(values, ['0001234567'])
        self.assertTrue(labelled)
        self.assertEqual(labelled_candidates('Data: 2026 Matrícula: 00012O4567')[0], [])
        self.assertEqual(labelled_candidates('Matrícula: 0001234567\nMATRICULA: 0001234567')[0], ['0001234567'])
        self.assertEqual(labelled_candidates('Data 20260101 Questões 1 a 25'), ([], False))

    def test_conflicting_low_confidence_and_absent_identity_never_guess(self):
        conflict = identity_result(['00001234', '00001235'], source='pdf_texto', confidence=1)
        self.assertEqual(conflict['matricula_status'], 'AMBIGUA')
        self.assertIsNone(conflict['matricula_detectada'])
        uncertain = identity_result(['00001234'], source='ocr', confidence=.91)
        self.assertEqual(uncertain['matricula_status'], 'INCERTA')
        self.assertIsNone(uncertain['matricula_detectada'])
        self.assertEqual(identity_result()['matricula_status'], 'AUSENTE')

    def test_ocr_label_tolerates_one_error_but_never_repairs_enrollment_digits(self):
        for label in ('Matriculs', 'Matrlcula', 'Matricla', 'Matriculas'):
            text = label + ': 0000654321'
            with self.subTest(label=label):
                self.assertEqual(labelled_candidates(text), ([], False))
                self.assertEqual(labelled_candidates(text, allow_ocr_errors=True),
                                 (['0000654321'], True))
        for text in ('Materiais: 0000654321', 'Matriz: 0000654321',
                     'Matrlculs: 0000654321', 'Matriculs 0000654321'):
            with self.subTest(text=text):
                self.assertEqual(labelled_candidates(text, allow_ocr_errors=True), ([], False))
        self.assertEqual(labelled_candidates('Matriculs: 00006O4321', allow_ocr_errors=True),
                         ([], True))

    def test_ocr_misspelled_label_retains_confidence_and_detects_conflicts(self):
        from types import SimpleNamespace
        output = SimpleNamespace(txts=['Matriculs: 0000654321'], scores=[.97], boxes=[])
        values, labelled, confidence = _ocr_candidates(output)
        self.assertEqual(values, ['0000654321'])
        self.assertTrue(labelled)
        self.assertEqual(confidence, .97)
        self.assertEqual(identity_result(values, source='ocr', confidence=.91)['matricula_status'],
                         'INCERTA')
        output.txts = ['Matriculs: 0000654321', 'Matrlcula: 0000654322']
        output.scores = [.97, .98]
        values, _, confidence = _ocr_candidates(output)
        self.assertEqual(identity_result(values, source='ocr', confidence=confidence)['matricula_status'],
                         'AMBIGUA')

    def test_digital_pdf_extracts_each_page_without_ocr_or_filename(self):
        path = self.directory / '9999999999.pdf'
        digital_pdf(path, ['Data: 09/10/2026\nMatrícula: 0000123456',
                           'MATRICULA: 0000654321', 'Matricula: 0000123456\nMatricula: 0000654321'])
        with patch('omr.identity._ocr_engine', side_effect=AssertionError('PDF possui texto')):
            inspected = inspect_document(path)
        self.assertEqual(inspected['page_count'], 3)
        self.assertEqual(inspected['pages'][0]['matricula_detectada'], '0000123456')
        self.assertEqual(inspected['pages'][1]['matricula_detectada'], '0000654321')
        self.assertEqual(inspected['pages'][2]['matricula_status'], 'AMBIGUA')
        self.assertTrue(all(page['matricula_fonte'] == 'pdf_texto' for page in inspected['pages']))

    def test_document_info_and_chunk_selection_are_bounded_and_do_not_ocr(self):
        path = self.directory / 'batch.pdf'
        digital_pdf(path, ['Matrícula: 0000123456'] * 6)
        with patch('omr.identity._ocr_engine', side_effect=AssertionError('não é necessário')):
            self.assertEqual(document_info(path)['page_count'], 6)
            inspected = inspect_document(path, [6, 2])
        self.assertEqual([page['page_number'] for page in inspected['pages']], [6, 2])
        for invalid in (None, [], [1, 1], [1, 2, 3, 4, 5, 6], [0], [7], [True], ['1'], [1.5], [{}]):
            with self.subTest(pages=invalid), self.assertRaises(ValueError):
                inspect_document(path, invalid)
        digital_pdf(path, ['Matricula: 0000123456'] * 101)
        with self.assertRaises(ValueError):
            document_info(path)

    def test_one_unreadable_header_is_pending_without_discarding_other_pages(self):
        path = self.directory / 'mixed.pdf'
        digital_pdf(path, ['Matrícula: 0000123456', 'Cabeçalho ilegível'])
        with patch('omr.identity.load_image_or_pdf', side_effect=ValueError('página ilegível')):
            result = inspect_document(path)
        self.assertEqual(result['pages'][0]['matricula_detectada'], '0000123456')
        self.assertEqual(result['pages'][1]['matricula_status'], 'INCERTA')
        self.assertIsNone(result['pages'][1]['matricula_detectada'])

    def test_damaged_pdf_text_layer_can_fall_back_to_a_local_image(self):
        path = self.directory / 'scan.pdf'
        digital_pdf(path, ['Sem camada textual útil'])
        white = np.full((1000, 700, 3), 255, dtype=np.uint8)
        with (patch('omr.identity.extract_pdf_page_text', side_effect=ValueError('texto inválido')),
              patch('omr.identity.load_image_or_pdf', return_value=white),
              patch('omr.identity._ocr_engine', side_effect=AssertionError('sem tinta'))):
            identity = extract_page_identity(path)
        self.assertEqual(identity['matricula_status'], 'AUSENTE')

    def test_pdf_page_selection_retains_different_marks_and_rejects_silent_first_page(self):
        images, truths = [], []
        for seed in (40, 77, 121):
            rng = np.random.default_rng(seed)
            truth = {str(q): str(rng.choice(list('ABCDE'))) for q in range(1, 51)}
            truth['4'], truth['17'] = 'BNK', 'RAS'
            image, _ = identified_card(50, '0000' + str(seed).zfill(6), truth)
            images.append(Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)))
            truths.append(truth)
        path = self.directory / 'batch.pdf'
        images[0].save(path, format='PDF', save_all=True, append_images=images[1:], resolution=150)
        for number, truth in enumerate(truths, 1):
            result = process_image(path, question_count=50, page_number=number)
            self.assertEqual(result['respostas_detectadas'], truth, result['erro_msg'])
        failure = process_image(path, question_count=50)
        self.assertEqual(failure['status'], 'ERRO_LEITURA')
        self.assertIn('várias páginas', failure['erro_msg'])
        for invalid in (0, 4, True, '2', 2.5):
            with self.subTest(page=invalid):
                self.assertEqual(process_image(path, page_number=invalid)['status'], 'ERRO_LEITURA')

    def test_split_ocr_boxes_merge_only_adjacent_value_on_same_line(self):
        class Output:
            txts = ['Matrícula:', '0000123456', '20260101']
            scores = [.99, .98, .99]
            boxes = [[[0, 0], [70, 0], [70, 15], [0, 15]],
                     [[80, 0], [160, 0], [160, 15], [80, 15]],
                     [[80, 80], [160, 80], [160, 95], [80, 95]]]
        values, labelled, confidence = _ocr_candidates(Output())
        self.assertEqual(values, ['0000123456'])
        self.assertTrue(labelled)
        self.assertEqual(confidence, .98)

    def test_real_ocr_of_fictitious_image_scan_and_quarter_turn_keeps_zeroes_without_network(self):
        image, truth = identified_card(50, '0000123456')
        image_path = self.directory / 'wrong-name-9988776655.png'
        cv2.imwrite(str(image_path), image)
        path = self.directory / 'scan.pdf'
        Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)).save(path, 'PDF', resolution=150)
        with patch('requests.sessions.Session.request', side_effect=AssertionError('rede proibida no OCR')):
            for file in (image_path, path):
                identity = extract_page_identity(file)
                self.assertEqual(identity['matricula_detectada'], '0000123456', identity['erro_msg'])
                self.assertEqual(identity['matricula_fonte'], 'ocr')
            identity = extract_image_identity(cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE))
            self.assertEqual(identity['matricula_detectada'], '0000123456', identity['erro_msg'])

    def test_remote_manifest_and_selected_page_share_protocol(self):
        import base64
        path = self.directory / 'digital.pdf'
        digital_pdf(path, ['Matrícula: 0000123456', 'Matricula: 0000654321'])
        payload = {'name': 'unrelated.pdf', 'file_base64': base64.b64encode(path.read_bytes()).decode()}
        self.assertEqual(remote.execute({**payload, 'action': 'document_info'})['page_count'], 2)
        result = remote.execute({**payload, 'action': 'inspect_document', 'page_numbers': [2]})
        self.assertEqual(result['pages'][0]['matricula_detectada'], '0000654321')
        result = remote.execute({**payload, 'action': 'process', 'page_number': 2, 'include_identity': False})
        self.assertEqual(result['page_number'], 2)
        self.assertNotIn('matricula_detectada', result)


if __name__ == '__main__':
    unittest.main()
