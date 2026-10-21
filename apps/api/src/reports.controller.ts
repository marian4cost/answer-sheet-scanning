import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Post, Put, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { ContactsService } from './contacts.service';
import { ReportsService } from './reports.service';

@Controller()
export class ReportsController {
  constructor(@Inject(ContactsService) private readonly contacts: ContactsService, @Inject(ReportsService) private readonly reports: ReportsService) {}
  @Get('contatos') contactsList() { return this.contacts.list(); }
  @Put('contatos/:matricula') updateContact(@Param('matricula') matricula: string, @Body() body: unknown) { return this.contacts.update(matricula, body); }
  @Delete('contatos/:matricula') deleteContact(@Param('matricula') matricula: string, @Body() body: unknown) { return this.contacts.remove(matricula, body); }
  @Get('contatos/modelo.csv') template(@Res() response: Response) {
    response.setHeader('Content-Type', 'text/csv; charset=utf-8'); response.setHeader('Content-Disposition', 'attachment; filename="Modelo_Contatos.csv"'); response.send(this.contacts.template());
  }
  @Post('contatos/preview') @UseInterceptors(FileInterceptor('arquivo', {storage: memoryStorage(), limits: {fileSize: 2 * 1024 * 1024, files: 1, fields: 1}}))
  preview(@Body('ignorar_sem_email') skip: unknown, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Selecione uma planilha CSV ou XLSX.');
    return this.contacts.preview(file.buffer, file.originalname, skip === 'sim');
  }
  @Post('contatos/importar') import(@Body('token') token: unknown, @Body('confirmar') confirmation: unknown) { return this.contacts.import(token, confirmation); }
  @Get('simulados/:id/boletins') list(@Param('id', ParseIntPipe) id: number) { return this.reports.list(id); }
  @Get('resultados/:id/boletim') report(@Param('id', ParseIntPipe) id: number) { return this.reports.report(id); }
  @Get('resultados/:id/boletim/pdf') async pdf(@Param('id', ParseIntPipe) id: number, @Res() response: Response) {
    const buffer = await this.reports.pdf(id); response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `attachment; filename="Boletim_Resultado_${id}.pdf"`); response.send(buffer);
  }
  @Put('resultados/:id/redacao') essay(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) { return this.reports.saveEssay(id, body); }
  @Post('simulados/:id/boletins/planejar') plan(@Param('id', ParseIntPipe) id: number, @Body('resultado_ids') ids: unknown) { return this.reports.plan(id, ids); }
  @Post('simulados/:id/boletins/enviar') send(@Param('id', ParseIntPipe) id: number, @Body('token') token: unknown, @Body('confirmar') confirmation: unknown) { return this.reports.send(id, token, confirmation); }
  @Post('simulados/:id/boletins/reemitir/planejar') planReissue(@Param('id', ParseIntPipe) id: number, @Body('delivery_id') deliveryId: unknown) { return this.reports.planReissue(id, deliveryId); }
  @Post('simulados/:id/boletins/reemitir') reissue(@Param('id', ParseIntPipe) id: number, @Body('token') token: unknown, @Body('confirmar') confirmation: unknown) { return this.reports.reissue(id, token, confirmation); }
  @Post('boletim/consultar') @HttpCode(200)
  publicReport(@Body('token') token: unknown, @Res({passthrough:true}) response: Response) {
    this.accessHeaders(response);
    return this.reports.publicReport(token);
  }
  @Post('boletim/pdf') @HttpCode(200)
  async publicPdf(@Body('token') token: unknown, @Res() response: Response) {
    this.accessHeaders(response);
    const buffer = await this.reports.publicPdf(token);
    response.setHeader('Content-Type','application/pdf');
    response.setHeader('Content-Disposition','attachment; filename="Boletim_Individual.pdf"');
    response.send(buffer);
  }
  @Get('boletim/limpar')
  cleanup(@Req() request: Request, @Res({passthrough:true}) response: Response) {
    this.accessHeaders(response);
    return this.reports.cleanupAccess(request.get('authorization'));
  }
  private accessHeaders(response: Response) {
    response.setHeader('Cache-Control','private, no-store, max-age=0');
    response.setHeader('Pragma','no-cache');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    response.setHeader('X-Content-Type-Options','nosniff');
  }
  @Get('simulados/:id/boletins/entregas') deliveries(@Param('id', ParseIntPipe) id: number) { return this.reports.deliveries(id); }
}
