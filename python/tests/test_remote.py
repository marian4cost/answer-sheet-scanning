"""Regressões da função remota sem rede externa e sem dados pessoais."""
import base64
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from api import omr as remote
from variable_cards import printed_card

TEST_HOST = 'https://example.supabase.co'
TEST_OBJECT = TEST_HOST + '/storage/v1/object/sign/omr-private/processing/12345678-1234-1234-1234-123456789abc.png?token=mock-only'

class RemoteApiTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'SUPABASE_URL':TEST_HOST,'SUPABASE_STORAGE_BUCKET':'omr-private','OMR_REMOTE_SECRET':'mock-secret-only'})
        self.env.start()
    def tearDown(self):
        self.env.stop()
    def test_safe_url_accepts_only_configured_private_processing_object(self):
        self.assertEqual(remote.safe_url(TEST_OBJECT),TEST_OBJECT)
        invalid = [
            TEST_OBJECT.replace('https://','http://'), TEST_OBJECT.replace('example.supabase.co','evil.example.com'),
            TEST_OBJECT.replace('https://','https://user:pass@'), TEST_OBJECT.replace('omr-private','public'),
            TEST_OBJECT.replace('/sign/','/public/'), TEST_OBJECT.replace('/processing/','/uploads/'),
            TEST_OBJECT.split('?')[0], TEST_OBJECT + '#fragment',
            TEST_OBJECT.replace('12345678-1234-1234-1234-123456789abc.png','../debug.png'),
            TEST_OBJECT.replace('12345678-1234-1234-1234-123456789abc.png','%2e%2e%2fdebug.png'),
            TEST_OBJECT.replace('.png?','.html?'), 'file:///etc/passwd', 'http://127.0.0.1:8000/', None, 42,
        ]
        for url in invalid:
            with self.subTest(url=url),self.assertRaises(ValueError): remote.safe_url(url)
        with patch.dict(os.environ,{'SUPABASE_URL':''}),self.assertRaises(ValueError): remote.safe_url(TEST_OBJECT)
    def test_safe_url_accepts_exact_internal_import_namespaces_with_signed_token(self):
        for prefix in ('incoming','importing','processing'):
            for extension in ('pdf','jpg','jpeg','png','webp','bmp','tif','tiff'):
                url = TEST_OBJECT.replace('/processing/',f'/{prefix}/').replace('.png?',f'.{extension}?')
                with self.subTest(prefix=prefix,extension=extension):
                    self.assertEqual(remote.safe_url(url),url)
    def test_safe_url_rejects_encoded_paths_traversal_noncanonical_ids_and_query_bypasses(self):
        invalid = [
            TEST_OBJECT.replace('/processing/','/incoming/../processing/'),
            TEST_OBJECT.replace('/processing/','/incoming/%2e%2e/processing/'),
            TEST_OBJECT.replace('/processing/','/incoming%2f'),
            TEST_OBJECT.replace('/processing/','/%70rocessing/'),
            TEST_OBJECT.replace('/processing/','/importing%252f'),
            TEST_OBJECT.replace('/processing/','/importing//'),
            TEST_OBJECT.replace('/processing/','/incoming/subfolder/'),
            TEST_OBJECT.replace('/processing/','/reports/'),
            TEST_OBJECT.replace('/processing/','/processing-other/'),
            TEST_OBJECT.replace('omr-private','omr-private-public'),
            TEST_OBJECT.replace('.png?','.png;anything?'),
            TEST_OBJECT.replace('.png?','%2epng?'),
            TEST_OBJECT.replace('12345678-1234-1234-1234-123456789abc','------------------------------------'),
            TEST_OBJECT.replace('12345678-1234-1234-1234-123456789abc','12345678123412341234123456789abc'),
            TEST_OBJECT.replace('?token=mock-only','?token='),
            TEST_OBJECT.replace('?token=mock-only','?other=mock-only'),
            TEST_OBJECT + '&token=second', TEST_OBJECT + '&redirect=https://evil.example.com',
            TEST_OBJECT + '&', '\n' + TEST_OBJECT,
            TEST_OBJECT.replace('/processing/','/proce\tssing/'),
        ]
        for url in invalid:
            with self.subTest(url=url),self.assertRaises(ValueError):
                remote.safe_url(url)
    def test_redirects_are_never_followed_to_another_url(self):
        with self.assertRaises(ValueError): remote.NoRedirect().redirect_request(None,None,302,'Found',{},'https://evil.example.com')
    def test_health_does_not_read_files_or_send_requests(self):
        with patch.object(remote,'receive_file',side_effect=AssertionError('not needed')),patch.object(remote,'build_opener',side_effect=AssertionError('external network blocked')):
            self.assertTrue(remote.execute({'action':'health'})['ok'])
    def test_decodes_independently_generated_card_and_never_uses_answer_key_as_detection_truth(self):
        expected = {str(q):'EDCBA'[(q-1)%5] for q in range(1,61)}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'fixture.png';printed_card(60,answers=expected,output=path)
            encoded = base64.b64encode(path.read_bytes()).decode()
        payload = {'action':'process','name':'student.png','file_base64':encoded,'question_count':60,'answer_key':dict.fromkeys(map(str,range(1,61)),'A'),'debug':True}
        with patch.object(remote,'build_opener',side_effect=AssertionError('external network blocked')):
            reading = remote.execute(payload)
        self.assertEqual(reading['respostas_detectadas'],expected)
        self.assertIsNone(reading['debug_image_path'])
        self.assertIn('debug_image_base64',reading)
        self.assertNotIn('nota_percentual',reading)
    def test_unknown_white_image_returns_error_instead_of_fake_answers(self):
        stream=BytesIO();Image.new('RGB',(1000,1400),'white').save(stream,format='PNG')
        result=remote.execute({'action':'process','name':'white.png','file_base64':base64.b64encode(stream.getvalue()).decode(),'question_count':50})
        self.assertEqual(result['status'],'ERRO_LEITURA');self.assertEqual(result['respostas_detectadas'],{})
    def test_file_size_extension_invalid_base64_and_unknown_action_rejected_before_network(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(remote,'build_opener',side_effect=AssertionError('external network blocked')):
            for payload in [{'name':'bad.html','file_base64':'AAAA'},{'name':'bad.png','file_base64':'###'},{'name':'empty.png','file_base64':''},{'name':'large.png','file_base64':'A'*4000001}]:
                with self.subTest(payload=payload['name']),self.assertRaises(ValueError):remote.receive_file(payload,directory)
            with self.assertRaises(ValueError):remote.execute({'action':'arbitrary'})
            with self.assertRaises(ValueError):remote.execute({'action':'validate','files':[]})
    def run_handler(self,payload=None,secret='mock-secret-only',method='POST',length=None):
        server=object.__new__(remote.handler);content=json.dumps(payload or {'action':'health'}).encode()
        server.headers={'X-OMR-Secret':secret,'Content-Length':str(len(content) if length is None else length)}
        server.rfile=BytesIO(content);server.wfile=BytesIO();state={'headers':{}}
        server.send_response=lambda status:state.update(status=status)
        server.send_header=lambda key,value:state['headers'].update({key:value})
        server.end_headers=lambda:None
        if method=='GET':server.do_GET()
        else:server.do_POST()
        state['body']=json.loads(server.wfile.getvalue())
        return state
    def test_http_post_rejects_missing_wrong_and_unconfigured_secret_without_processing(self):
        with patch.object(remote,'execute',side_effect=AssertionError('must not process')):
            self.assertEqual(self.run_handler(secret='')['status'],401)
            self.assertEqual(self.run_handler(secret='wrong')['status'],401)
            with patch.dict(os.environ,{'OMR_REMOTE_SECRET':''}):self.assertEqual(self.run_handler()['status'],401)
    def test_http_non_ascii_wrong_secret_is_401_not_an_unhandled_exception(self):
        self.assertEqual(self.run_handler(secret='inválido')['status'],401)
    def test_http_post_authenticated_health_and_method_size_payload_checks(self):
        with patch.object(remote,'build_opener',side_effect=AssertionError('external network blocked')):
            ok=self.run_handler();self.assertEqual(ok['status'],200);self.assertTrue(ok['body']['ok']);self.assertEqual(ok['headers']['Cache-Control'],'no-store')
            self.assertEqual(self.run_handler(method='GET')['status'],405)
            self.assertEqual(self.run_handler(length=0)['status'],400)
            self.assertEqual(self.run_handler(length=4000001)['status'],400)
            self.assertEqual(self.run_handler(payload=['not','an','object'])['status'],400)

if __name__=='__main__':unittest.main()
