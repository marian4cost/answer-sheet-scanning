#!/usr/bin/env python3
"""Protocolo JSON por stdin/stdout, invocado pelo NestJS. Não inicia servidor."""
import json
import logging
import sys

import cv2

from omr.engine import process_image
from omr.validation import validate_file
from omr.pdf_loader import document_info
from omr.identity import inspect_document, extract_page_identity

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
cv2.setNumThreads(1)


def main():
    payload = json.load(sys.stdin)
    action = payload.get('action', 'process')
    if action == 'health':
        return {'ok': True, 'opencv': cv2.__version__, 'pdf_engine': 'PDFium', 'poppler': False}
    if action == 'validate':
        for file in payload['files']:
            try:
                validate_file(file['path'])
            except Exception as exc:
                raise ValueError(f"{file['name']}: {exc}") from exc
        return {'ok': True}
    if action not in {'process', 'document_info', 'inspect_document'}:
        raise ValueError('Ação de processamento inválida.')
    validate_file(payload['file_path'])
    if action == 'document_info':
        return document_info(payload['file_path'])
    if action == 'inspect_document':
        return inspect_document(payload['file_path'], payload.get('page_numbers'))
    reading = process_image(payload['file_path'], payload.get('answer_key'), payload.get('debug_path'),
                            question_count=payload.get('question_count', 50), page_number=payload.get('page_number'))
    reading['page_number'] = payload.get('page_number') if payload.get('page_number') is not None else 1
    if payload.get('include_identity', True) and reading['status'] != 'ERRO_LEITURA':
        # A mensagem OMR e o diagnóstico de identificação possuem escopos distintos.
        identity = extract_page_identity(payload['file_path'], payload.get('page_number') or 1)
        reading['matricula_erro_msg'] = identity.pop('erro_msg')
        reading.update(identity)
    return reading


if __name__ == '__main__':
    try:
        json.dump(main(), sys.stdout, ensure_ascii=False, allow_nan=False)
        sys.stdout.write('\n')
    except Exception as exc:
        json.dump({'error': str(exc)}, sys.stdout, ensure_ascii=False)
        sys.stdout.write('\n')
        sys.exit(1)
