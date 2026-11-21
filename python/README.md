# 📑 Answer Sheet Scanning (Motor OMR com OpenCV e Python)

Motor de alta precisão para **Reconhecimento Óptico de Marcas (OMR - Optical Mark Recognition)** e digitalização de cartões-resposta (ENEM, simulados, provas escolares e concursos). Desenvolvido em Python com **OpenCV**, **PDFium** e **RapidOCR/ONNX**, o projeto é capaz de ler e corrigir provas a partir de fotos tiradas por smartphone ou PDFs digitalizados em alta resolução.

---

## 🚀 Destaques e Diferenciais

- **Detecção Híbrida de Gabaritos**:
  - **Com Marcadores Fiduciais**: Localização dos 4 marcadores quadrados nos cantos, transformação de perspectiva (*warp perspective*) e validação estrita da grade de bolhas.
  - **Cartão Impresso sem Marcadores**: Segmentação morfológica em duas colunas, detecção de orientação e rotação (*deskew* com `minAreaRect`), retificação colunar e busca refinada de alternativas de (A) a (E).
- **Tratamento Avançado de Imagem**:
  - Binarização adaptativa e normalização de plano de fundo via divisão Gaussiana (`cv2.GaussianBlur` + `cv2.divide`), eliminando sombras e variações de iluminação sem engrossar a tipografia.
  - Correção automática de orientação (0°, 90°, 180°, 270°).
- **Calibração Dinâmica de Linha de Base (*Baseline*)**:
  - Compensa a diferença natural de tinta entre letras impressas (por exemplo, as letras **B** e **D** têm graficamente mais tinta do que a letra **C**).
  - Calcula linhas de base adaptativas a partir da própria folha (percentil 30 e menor média de preenchimento), evitando falsos positivos.
- **Classificação Inteligente das Respostas**:
  - `A`, `B`, `C`, `D`, `E`: Alternativa convicta identificada.
  - `BNK` (*Blank*): Questão deixada em branco pelo aluno.
  - `RAS` (*Rasura*): Múltiplas alternativas marcadas ou preenchimento total.
  - `INC` (*Incerta*): Preenchimento ambíguo ou incompleto que sinaliza necessidade de revisão humana no sistema.
- **Extração Automática de Matrícula do Aluno**:
  - Extração de texto vetorial direto do PDF ou via OCR local de baixa latência (**RapidOCR** com modelo ONNX), ancorado de forma estrita na indicação de matrícula.
- **Auditoria Visual (*Debug Overlay*)**:
  - Gera espelho do cartão anotado com círculos coloridos (verde para acerto, vermelho para erro/rasura, laranja para incerteza, azul para gabarito oficial) preservando o traço da caneta original do estudante e inserindo banner com sumário da correção.

---

## 📂 Estrutura do Projeto

```plaintext
.
├── omr/
│   ├── engine.py       # Motor principal: processamento de imagem, alinhamento, medição e classificação
│   ├── identity.py     # Detecção e OCR de matrícula do estudante
│   ├── pdf_loader.py   # Renderização vetorial de PDFs com pypdfium2 (300 DPI)
│   └── validation.py   # Validação de integridade, limites de memória e formatos de arquivo
├── api/
│   └── omr.py          # Handler serverless / HTTP com autenticação por HMAC e cabeçalhos seguros
├── worker.py           # Interface CLI IPC (JSON via stdin/stdout) para integração com outras linguagens
├── sample_sheets.py    # Gerador de folhas de teste e cenários de validação
├── requirements.txt    # Dependências do projeto
└── tests/              # Suíte de testes unitários e testes de regressão
```

---

## 🛠️ Instalação e Pré-requisitos

Recomenda-se o uso de **Python 3.10+**.

```bash
# Crie e ative um ambiente virtual
python3 -m venv .venv
source .venv/bin/activate  # No Linux/macOS
# .venv\Scripts\activate   # No Windows

# Instale as dependências
pip install -r requirements.txt
```

As dependências incluem:
- `opencv-python-headless`: Manipulação e visão computacional leve (sem dependências de GUI).
- `numpy`: Vetorização e cálculo matricial.
- `Pillow`: Manipulação de imagens e validação de segurança.
- `pypdfium2`: Rasterização de PDF de alto desempenho.
- `rapidocr` e `onnxruntime`: OCR leve e veloz para extração de identificação.

---

## 💻 Como Utilizar

### 1. Uso Direto em Python (Biblioteca)

A principal função do motor é `process_image` presente em `omr.engine`:

```python
from omr.engine import process_image

resultado = process_image(
    file_path="caminho/do/cartao.jpg",     # Suporta JPG, PNG, WEBP, BMP, TIFF e PDF
    answer_key={                           # Opcional: Gabarito oficial para comparação
        "1": "A", "2": "B", "3": "C", "4": "D", "5": "E"
    },
    output_debug_path="espelho_saida.png", # Opcional: Gera espelho anotado para conferência
    question_count=50,                     # Quantidade de questões (50 a 60)
    page_number=1                          # Caso o arquivo seja um PDF multipágina
)

# Exemplo de retorno:
print("Status da leitura:", resultado["status"])
print("Respostas detectadas:", resultado["respostas_detectadas"])
# Saída: {'1': 'A', '2': 'B', '3': 'INC', '4': 'RAS', '5': 'BNK', ...}
```

#### Parâmetros da função `process_image`:
| Parâmetro | Tipo | Padrão | Descrição |
| :--- | :--- | :--- | :--- |
| `file_path` | `str` \| `Path` | *Obrigatório* | Caminho da imagem ou arquivo PDF no disco. |
| `answer_key` | `dict` | `{}` | Dicionário `{ "1": "A", ... }` com as respostas oficiais. |
| `output_debug_path` | `str` \| `Path` | `None` | Caminho de destino para salvar a imagem de auditoria (espelho). |
| `question_count` | `int` | `50` | Quantidade total de questões no cartão (suporta de 50 a 60). |
| `page_number` | `int` | `1` | Número da página a ser processada em caso de arquivo PDF. |

#### Estrutura do Dicionário de Retorno:
```json
{
  "status": "SUCESSO", // "SUCESSO", "ALERTA_REVISAO", "ALERTA_RASURA" ou "ERRO_LEITURA"
  "layout": "cartao_impresso", // "marcadores" ou "cartao_impresso"
  "respostas_detectadas": {
    "1": "A",
    "2": "C",
    "3": "BNK",
    "4": "RAS"
  },
  "qualidade_questoes": {
    "1": { "estado": "A", "margem_tinta": 0.42, "excesso_tinta": 0.51, "revisar": false }
  },
  "debug_image_path": "espelho_saida.png",
  "erro_msg": ""
}
```

---

## 🌐 Como Integrar em uma Aplicação Maior (Sites, APIs e Monólitos)

Este motor foi concebido para ser facilmente plugado em arquiteturas de backend web. Abaixo estão as formas recomendadas de integração:

### Cenário A: Microserviço REST Dedicado com FastAPI (Python)

Se a sua aplicação web utiliza uma arquitetura de microsserviços ou você deseja expor um endpoint HTTP para receber uploads de cartões:

```python
# main.py
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from omr.engine import process_image
from omr.identity import extract_page_identity
import shutil
import tempfile
from pathlib import Path
import json

app = FastAPI(title="Answer Sheet Scanning API")

@app.post("/api/v1/scan")
async def scan_answer_sheet(
    file: UploadFile = File(...),
    question_count: int = Form(50),
    answer_key_json: str = Form(None)
):
    answer_key = json.loads(answer_key_json) if answer_key_json else {}

    # Salva o arquivo temporariamente em disco
    suffix = Path(file.filename).suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_file:
        shutil.copyfileobj(file.file, tmp_file)
        tmp_path = tmp_file.name

    debug_path = tmp_path.replace(suffix, "_debug.png")

    try:
        # 1. Leitura das marcações OMR
        resultado = process_image(
            file_path=tmp_path,
            answer_key=answer_key,
            output_debug_path=debug_path,
            question_count=question_count
        )

        # 2. Extração de matrícula do aluno (se aplicável)
        if resultado["status"] != "ERRO_LEITURA":
            identidade = extract_page_identity(tmp_path, page_number=1)
            resultado["matricula"] = identidade.get("matricula")
            resultado["matricula_confianca"] = identidade.get("matricula_confianca")

        return resultado
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        # Limpeza de arquivos temporários
        Path(tmp_path).unlink(missing_ok=True)
        # O debug_path pode ser enviado para um bucket S3/Cloud Storage antes de ser deletado
```

---

### Cenário B: Backend Node.js / NestJS / Express via Processo Filho (IPC)

Se o backend principal do seu site for em **Node.js / TypeScript**, não é necessário manter um servidor HTTP Python ativo em memória. Você pode invocar o `worker.py` diretamente via `subprocess` (stdin/stdout):

```typescript
// omr.service.ts (NestJS / Node.js)
import { spawn } from 'child_process';
import * as path from 'path';

interface OmrPayload {
  action: 'process';
  file_path: string;
  question_count?: number;
  answer_key?: Record<string, string>;
  debug_path?: string;
  include_identity?: boolean;
}

export async function processAnswerSheet(payload: OmrPayload): Promise<any> {
  return new Promise((resolve, reject) => {
    const workerPath = path.resolve(__dirname, '../../python/worker.py');
    const pythonProcess = spawn('python3', [workerPath]);

    let outputData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (chunk) => {
      outputData += chunk.toString();
    });

    pythonProcess.stderr.on('data', (chunk) => {
      errorData += chunk.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Worker falhou com código ${code}: ${errorData}`));
      }
      try {
        const parsed = JSON.parse(outputData);
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Falha ao converter resposta do OMR: ${err.message}`));
      }
    });

    // Envia o payload via stdin
    pythonProcess.stdin.write(JSON.stringify(payload));
    pythonProcess.stdin.end();
  });
}
```

---

### Cenário C: Processamento em Fila / Background Jobs (Upload em Lote)

Para sistemas de grande escala (por exemplo, upload de PDF com 500 páginas de um simulado completo):
1. **Frontend / Web**: O usuário envia o arquivo PDF ou lote de imagens.
2. **API**: Recebe o arquivo, salva em um storage (AWS S3, MinIO, Supabase Storage, Google Cloud Storage) e enfileira uma mensagem em uma fila assíncrona (RabbitMQ, Redis/BullMQ, AWS SQS, Celery).
3. **OMR Workers**: Workers desacoplados consomem as mensagens, processam as páginas individualmente e persistem as notas e o espelho de correção no banco de dados.
4. **Notificação em Tempo Real**: Notifica o frontend via WebSockets ou Server-Sent Events (SSE) quando a correção estiver concluída.

---

### Cenário D: Serverless / Cloud Functions

O projeto já inclui um manipulador HTTP em `api/omr.py` pronto para ambientes como **Vercel Functions** ou **AWS Lambda** (usando container ou camadas com OpenCV):
- Autenticação via cabeçalho `X-OMR-Secret` comparado com HMAC.
- Suporte a recebimento de imagens via Base64 ou URLs assinadas de storage seguro com proteção contra redirecionamentos indesejados.

---

## 📊 Critérios de Correção e Auditoria

1. **Margem de Tinta e Segurança**: Cada questão computa `margem_tinta` e `excesso_tinta`. Se a diferença entre a opção mais preenchida e a segunda for pequena, o sistema marca a questão como `INC` para evitar atribuir nota errada por engano.
2. **Preservação Visual da Folha**: As anotações de auditoria geradas desenham elipses ligeiramente expandidas em torno da alternativa, garantindo que o traço original do estudante permaneça visível para eventuais recursos.

---

## 📄 Licença

Distribuído sob a licença MIT. Consulte o arquivo de licença para mais informações.
