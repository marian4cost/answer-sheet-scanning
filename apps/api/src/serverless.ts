import type { Request, Response } from 'express';
import { createApplication } from './bootstrap';

// Uma aplicação por instância; chamadas simultâneas compartilham a inicialização.
let application: ReturnType<typeof createApplication> | undefined;
export async function serverlessHandler(request: Request, response: Response) {
  application ??= createApplication(false).then(async app => { await app.init(); return app; });
  try {
    const app = await application;
    app.getHttpAdapter().getInstance()(request, response);
  } catch (error) {
    application = undefined;
    console.error('Falha na inicialização da API.', error instanceof Error ? error.name : 'unknown');
    response.status(503).json({message: 'O serviço está temporariamente indisponível.'});
  }
}
