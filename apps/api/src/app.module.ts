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
import { EssayImportController } from './essay-import.controller';
import { EssayImportService } from './essay-import.service';
import { ProofImportController } from './proof-import.controller';
import { ProofImportService } from './proof-import.service';
@Module({controllers: [AppController, UploadsController, ReportsController, AuthController, EssayImportController, ProofImportController], providers: [DatabaseService, SimuladosService, OmrService, ExportService, StorageService, UploadsService, ContactsService, ReportsService, ReportEmailGateway, AuthService, EmailJsService, EssayImportService, ProofImportService]})
export class AppModule {}
