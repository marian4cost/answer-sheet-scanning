import { Body, Controller, Inject, Param, ParseIntPipe, Post } from '@nestjs/common';
import { UploadsService } from './uploads.service';

@Controller()
export class UploadsController {
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService) {}
  @Post('uploads/preparar')
  prepare(@Body('files') files: unknown) { return this.uploads.prepare(files); }
  @Post('leituras/gabarito/armazem')
  readOfficial(@Body('upload_id') uploadId: unknown, @Body('total_questoes') count: unknown) { return this.uploads.readOfficial(uploadId, count); }
  @Post('simulados/:id/provas/armazem')
  uploadStudents(@Param('id', ParseIntPipe) id: number, @Body('upload_ids') uploadIds: unknown, @Body('matriculas') matriculas: unknown) {
    return this.uploads.uploadStudents(id, uploadIds, matriculas);
  }
}
