import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post } from '@nestjs/common';
import { SimuladoSharesService } from './simulado-shares.service';

@Controller('simulados/:id/compartilhamentos')
export class SimuladoSharesController {
  constructor(@Inject(SimuladoSharesService) private readonly shares: SimuladoSharesService) {}
  @Get() list(@Param('id', ParseIntPipe) id: number) { return this.shares.list(id); }
  @Post() share(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) { return this.shares.share(id, body); }
  @Delete(':shareId') revoke(@Param('id', ParseIntPipe) id: number, @Param('shareId') shareId: string) { return this.shares.revoke(id, shareId); }
}
