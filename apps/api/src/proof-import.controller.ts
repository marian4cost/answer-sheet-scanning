import { BadRequestException, Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { Response } from 'express';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ALLOWED_EXTENSIONS, MAX_FILE_SIZE, MEDIA_ROOT } from './config';
import { ProofImportService } from './proof-import.service';

const options:MulterOptions={storage:diskStorage({destination:(_req,_file,done)=>{const directory=join(MEDIA_ROOT,'.staging');mkdir(directory,{recursive:true}).then(()=>done(null,directory),()=>done(new Error('Não foi possível preparar o envio de arquivos.'),directory));},filename:(_req,file,done)=>done(null,randomUUID()+extname(file.originalname).toLowerCase())}),
  limits:{fileSize:MAX_FILE_SIZE,files:50,fields:0},fileFilter:(_req,file,done)=>{if(!ALLOWED_EXTENSIONS.includes(extname(file.originalname).toLowerCase())) return done(new BadRequestException('Use PDF ou imagens JPEG, PNG, WEBP, BMP ou TIFF.'),false);done(null,true);}};
@Controller()
export class ProofImportController {
  constructor(@Inject(ProofImportService) private readonly proofs:ProofImportService) {}
  @Post('simulados/:id/provas/importacoes') @UseInterceptors(FilesInterceptor('pdf_files',50,options))
  prepareLocal(@Param('id',ParseIntPipe) id:number,@UploadedFiles() files:Express.Multer.File[]) {return this.proofs.prepareLocal(id,files || []);}
  @Post('simulados/:id/provas/importacoes/armazem')
  prepareStored(@Param('id',ParseIntPipe) id:number,@Body('upload_ids') ids:unknown) {return this.proofs.prepareStored(id,ids);}
  @Get('simulados/:id/provas/importacoes') list(@Param('id',ParseIntPipe) id:number) {return this.proofs.list(id);}
  @Get('provas/importacoes/:planId') get(@Param('planId') id:string) {return this.proofs.get(id);}
  @Post('provas/importacoes/:planId/identificar') identify(@Param('planId') id:string) {return this.proofs.identify(id);}
  @Post('provas/importacoes/:planId/confirmar') confirm(@Param('planId') id:string,@Body('paginas') pages:unknown,@Body('confirmar') confirmation:unknown,@Body('permitir_repetidas') repeated:unknown) {return this.proofs.confirm(id,pages,confirmation,repeated);}
  @Post('provas/importacoes/:planId/processar') process(@Param('planId') id:string) {return this.proofs.process(id);}
  @Post('provas/importacoes/:planId/cancelar') cancel(@Param('planId') id:string) {return this.proofs.cancel(id);}
  @Get('provas/importacoes/:planId/arquivo/:index') async source(@Param('planId') id:string,@Param('index',ParseIntPipe) index:number,@Res() response:Response) {
    const source=await this.proofs.source(id,index);response.setHeader('Cache-Control','private, no-store');response.setHeader('Content-Type',source.contentType);
    response.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(source.name)}`);response.setHeader('X-Content-Type-Options','nosniff');response.send(source.buffer);
  }
}
