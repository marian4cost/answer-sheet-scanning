#!/usr/bin/env python3
"""Protocolo JSON por stdin/stdout, invocado pelo NestJS. Não inicia servidor."""
import json
import logging
import shutil
import sys

import cv2

from omr.engine import process_image
from omr.validation import validate_file

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
cv2.setNumThreads(1)


def main():
    payload = json.load(sys.stdin)
    action = payload.get('action', 'process')
    if action == 'health':
        return {'ok': bool(shutil.which('pdftoppm')), 'opencv': cv2.__version__, 'poppler': bool(shutil.which('pdftoppm'))}
    if action == 'validate':
        for file in payload['files']:
            try:
                validate_file(file['path'])
            except Exception as exc:
                raise ValueError(f"{file['name']}: {exc}") from exc
        return {'ok': True}
    if action != 'process':
        raise ValueError('Ação de processamento inválida.')
    validate_file(payload['file_path'])
    return process_image(payload['file_path'], payload.get('answer_key'), payload.get('debug_path'),
                         question_count=payload.get('question_count', 50))


if __name__ == '__main__':
    try:
        json.dump(main(), sys.stdout, ensure_ascii=False, allow_nan=False)
        sys.stdout.write('\n')
    except Exception as exc:
        json.dump({'error': str(exc)}, sys.stdout, ensure_ascii=False)
        sys.stdout.write('\n')
        sys.exit(1)
