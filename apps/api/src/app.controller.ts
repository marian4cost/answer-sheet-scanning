import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Res, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { Response } from 'express';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { SimuladosService } from './simulados.service';
import { OmrService } from './omr.service';
import { ExportService } from './export.service';
import { MEDIA_ROOT, MAX_FILE_SIZE, ALLOWED_EXTENSIONS, STORAGE_MODE } from './config';
import { questionCount } from './question-config';
import { DatabaseService } from './database.service';

const uploadOptions: MulterOptions = {
  storage: diskStorage({destination: join(MEDIA_ROOT, '.staging'), filename: (_req, file, done) => done(null, randomUUID() + extname(file.originalname).toLowerCase())}),
  limits: {fileSize: MAX_FILE_SIZE, files: 50, fields: 5},
  fileFilter: (_req, file, done) => {
    if (!ALLOWED_EXTENSIONS.includes(extname(file.originalname).toLowerCase())) return done(new BadRequestException('Formato não suportado. Use PDF, JPEG/JPG, PNG, WEBP, BMP ou TIFF.'), false);
    done(null, true);
  },
};

@Controller()
export class AppController {
  constructor(@Inject(SimuladosService) private readonly simulados: SimuladosService,
    @Inject(OmrService) private readonly omr: OmrService, @Inject(ExportService) private readonly exporter: ExportService,
    @Inject(DatabaseService) private readonly db: DatabaseService) {}
  @Get('health') async health() { await this.db.health(); return {backend: 'NestJS', database: 'ok', processor: await this.omr.health()}; }
  @Get('config') config() { return {private_uploads: STORAGE_MODE === 'supabase', min_questoes: 50, max_questoes: 60}; }
  @Post('leituras/gabarito') @UseInterceptors(FileInterceptor('gabarito_pdf', uploadOptions))
  async preview(@UploadedFile() file: Express.Multer.File | undefined, @Body('total_questoes') count: unknown) {
    if (!file) throw new BadRequestException('Selecione a folha do professor.');
    const debug = join(MEDIA_ROOT, 'debug_images', randomUUID() + '_preview.png');
    try {
      const total = questionCount(count);
      await this.omr.validate([file]);
      const reading = await this.omr.process(file.path, {}, debug, total);
      return {...reading, debug_image_path: null};
    } finally { await rm(file.path, {force: true}); await rm(debug, {force: true}); }
  }
  @Get('simulados') dashboard() { return this.simulados.dashboard(); }
  @Post('simulados') @UseInterceptors(FileInterceptor('gabarito_pdf', uploadOptions))
  create(@Body('titulo') titulo: unknown, @UploadedFile() file?: Express.Multer.File,
    @Body('total_questoes') count?: unknown, @Body('temas') themes?: unknown,
    @Body('gabarito_manual') key?: unknown) { return this.simulados.create(titulo, file, count, themes, key); }
  @Get('simulados/:id') detail(@Param('id', ParseIntPipe) id: number) { return this.simulados.detail(id); }
  @Put('simulados/:id/gabarito') @UseInterceptors(FileInterceptor('novo_gabarito_pdf', uploadOptions))
  update(@Param('id', ParseIntPipe) id: number, @UploadedFile() file?: Express.Multer.File,
    @Body('temas') themes?: unknown, @Body('gabarito_manual') key?: unknown) { return this.simulados.updateKey(id, file, themes, key); }
  @Put('simulados/:id/temas')
  themes(@Param('id', ParseIntPipe) id: number, @Body('temas') themes: unknown) { return this.simulados.updateThemes(id, themes); }
  @Post('simulados/:id/provas') @UseInterceptors(FilesInterceptor('pdf_files', 50, uploadOptions))
  upload(@Param('id', ParseIntPipe) id: number, @UploadedFiles() files: Express.Multer.File[], @Body('matriculas') matriculas?: unknown) { return this.simulados.upload(id, files || [], matriculas); }
  @Get('resultados/:id/imagem') async image(@Param('id', ParseIntPipe) id: number, @Res() response: Response) {
    const image = await this.simulados.debugImage(id);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Type', image.contentType);
    response.send(image.buffer);
  }
  @Get('simulados/:id/resultados') results(@Param('id', ParseIntPipe) id: number) { return this.simulados.results(id); }
  @Get('envios/:id') batch(@Param('id', ParseIntPipe) id: number) { return this.simulados.batch(id); }
  @Get('resultados/:id') result(@Param('id', ParseIntPipe) id: number) { return this.simulados.result(id); }
  @Delete('simulados/:id') delete(@Param('id', ParseIntPipe) id: number, @Body('confirmar') confirmation: unknown) { return this.simulados.delete(id, confirmation); }
  @Get('simulados/:id/exportar') async exportSimulado(@Param('id', ParseIntPipe) id: number, @Res() response: Response) {
    const data = await this.simulados.results(id);
    this.sendExcel(response, await this.exporter.create(data), `Resultado_Simulado_${id}_Completo.xlsx`);
  }
  @Get('envios/:id/exportar') async exportBatch(@Param('id', ParseIntPipe) id: number, @Res() response: Response) {
    const data = await this.simulados.batch(id);
    this.sendExcel(response, await this.exporter.create(data), `Resultado_Simulado_${data.simulado.id}_Envio_${id}.xlsx`);
  }
  private sendExcel(response: Response, content: Buffer, filename: string) {
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.send(content);
  }
}
