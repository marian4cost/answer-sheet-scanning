import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { AccountsService } from './accounts.service';
@Controller('contas')
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}
  @Get() list() { return this.accounts.list(); }
  @Post() create(@Body() body: unknown) { return this.accounts.create(body); }
  @Patch(':id/role') role(@Param('id') id: string, @Body() body: unknown) { return this.accounts.changeRole(id,body); }
  @Put('perfil') profile(@Body() body: unknown) { return this.accounts.updateProfile(body); }
  @Delete(':id') delete(@Param('id') id: string, @Body() body: unknown) { return this.accounts.delete(id,body); }
}
