import { ServiceUnavailableException } from '@nestjs/common';

// Apenas recusas explícitas ou validações anteriores à transmissão. Um timeout
// não garante que o provedor deixou de aceitar a mensagem.
export class EmailNotSentError extends ServiceUnavailableException {}
