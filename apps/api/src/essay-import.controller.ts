import { BadRequestException, Body, Controller, Inject, Param, ParseIntPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { EssayImportService } from './essay-import.service';

@Controller('simulados/:id/redacoes')
export class EssayImportController {
  constructor(@Inject(EssayImportService) private readonly essays: EssayImportService) {}
  @Post('preview')
  @UseInterceptors(FileInterceptor('arquivo',{storage:memoryStorage(),limits:{fileSize:2 * 1024 * 1024,files:1,fields:1}}))
  preview(@Param('id',ParseIntPipe) id: number, @Body('ignorar_sem_resultado') skip: unknown, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Selecione a planilha XLSX ou CSV com as avaliações de redação.');
    return this.essays.preview(id,file.buffer,file.originalname,skip === 'sim');
  }
  @Post('importar')
  import(@Param('id',ParseIntPipe) id: number, @Body('token') token: unknown, @Body('confirmar') confirmation: unknown, @Body('atualizar_existentes') update: unknown) {
    return this.essays.import(id,token,confirmation,update);
  }
}
