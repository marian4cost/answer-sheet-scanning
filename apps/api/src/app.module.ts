import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { DatabaseService } from './database.service';
import { SimuladosService } from './simulados.service';
import { OmrService } from './omr.service';
import { ExportService } from './export.service';
import { StorageService } from './storage.service';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { ReportsController } from './reports.controller';
import { ContactsService } from './contacts.service';
import { ReportsService, ReportEmailGateway } from './reports.service';
import { AuthController, AuthService } from './auth';
import { EmailJsService } from './emailjs.service';
import { SesService } from './ses.service';
import { EssayImportController } from './essay-import.controller';
import { EssayImportService } from './essay-import.service';
import { ProofImportController } from './proof-import.controller';
import { ProofImportService } from './proof-import.service';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { SimuladoSharesController } from './simulado-shares.controller';
import { SimuladoSharesService } from './simulado-shares.service';
@Module({controllers: [AppController, UploadsController, ReportsController, AuthController, EssayImportController, ProofImportController, AccountsController, SimuladoSharesController], providers: [DatabaseService, SimuladosService, OmrService, ExportService, StorageService, UploadsService, ContactsService, ReportsService, ReportEmailGateway, AuthService, EmailJsService, SesService, EssayImportService, ProofImportService, AccountsService, SimuladoSharesService]})
export class AppModule {}
