import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_ROOT, WEB_PORT } from './config';
import { AppModule } from './app.module';
import { AuthService } from './auth';

export async function createApplication(logger = true) {
  for (const path of ['.staging', 'uploads', 'debug_images']) mkdirSync(join(MEDIA_ROOT, path), {recursive: true});
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {logger: logger ? undefined : false});
  app.set('trust proxy', process.env.VERCEL ? 1 : 'loopback');
  const origins = [`http://localhost:${WEB_PORT}`, `http://127.0.0.1:${WEB_PORT}`, ...(process.env.CORS_ORIGINS || process.env.WEB_URL || '').split(',').map(value => value.trim()).filter(Boolean)];
  app.enableCors({origin: origins, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'X-OMR-Client', 'Authorization']});
  app.use(app.get(AuthService).middleware());
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.get('X-OMR-Client') !== 'web' || (req.get('origin') && !origins.includes(req.get('origin')!))) {
        res.status(403).json({message: 'Requisição não autorizada. Utilize os formulários do site.'}); return;
      }
    }
    next();
  });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}
