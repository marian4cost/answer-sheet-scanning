import type { Request, Response } from 'express';
import { createApplication } from './bootstrap';

// Uma aplicação por instância; chamadas simultâneas compartilham a inicialização.
let application: ReturnType<typeof createApplication> | undefined;
export async function serverlessHandler(request: Request, response: Response) {
  const initializing = application ??= createApplication(false).then(async app => {
    try { await app.init(); return app; }
    catch (error) {
      await app.close().catch(() => {});
      throw error;
    }
  });
  try {
    const app = await initializing;
    app.getHttpAdapter().getInstance()(request, response);
  } catch (error) {
    if (application === initializing) application = undefined;
    console.error('Falha na inicialização da API.', error instanceof Error ? error.name : 'unknown');
    response.status(503).json({message: 'O serviço está temporariamente indisponível.'});
  }
}
