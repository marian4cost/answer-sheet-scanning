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
@Module({controllers: [AppController, UploadsController, ReportsController, AuthController], providers: [DatabaseService, SimuladosService, OmrService, ExportService, StorageService, UploadsService, ContactsService, ReportsService, ReportEmailGateway, AuthService, EmailJsService]})
export class AppModule {}
