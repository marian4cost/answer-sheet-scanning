import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AnswerKey, OMRReading, ReadingStatus } from '@enem/shared';
import type { DocumentIdentity, DocumentInspection, ProofImportPlan, ProofImportPage } from '@enem/shared/src/proof-import';
import { DatabaseService } from './database.service';
import { StorageService } from './storage.service';
import { OmrService } from './omr.service';
import { SimuladosService } from './simulados.service';
import { UploadsService } from './uploads.service';
import { ALLOWED_EXTENSIONS, MAX_FILE_SIZE, MEDIA_ROOT, OMR_REMOTE_URL } from './config';
import { grade, invalidQuestions } from './grading';
import { questionCount } from './question-config';
import { accountId, withAccount } from './account-context';

type SourceFile = {name:string;key:string;size:number;pages:number};
type PlanPayload = {files:SourceFile[];key:AnswerKey;count:number;key_hash:string;cleaned?:boolean};
type PlanRow = {id:string;simulado_id:number;payload:string;estado:ProofImportPlan['estado'];criado_em:string;expira_em:string;envio_id:number|null};
type PageRow = {id:string;plan_id:string;file_index:number;page_number:number;identity:string|null;matricula:string;estado:ProofImportPage['estado'];claim_id:string|null;claim_at:string|null;resultado_id:number|null};
const MAX_PAGES = 100, LEASE_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fingerprint = (key:AnswerKey,count:number) => createHash('sha256').update(JSON.stringify([key,count])).digest('hex');
const validId = (value:unknown): value is string => typeof value === 'string' && !!value.trim() && value.trim().length <= 100 && !/[\x00-\x1f]/.test(value);
const contentType = (name:string) => ({'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.bmp':'image/bmp','.tif':'image/tiff','.tiff':'image/tiff'} as Record<string,string>)[extname(name).toLowerCase()] || 'application/octet-stream';

@Injectable()
export class ProofImportService {
  constructor(@Inject(DatabaseService) private readonly db:DatabaseService, @Inject(StorageService) private readonly storage:StorageService,
    @Inject(OmrService) private readonly omr:OmrService, @Inject(SimuladosService) private readonly simulados:SimuladosService,
    @Inject(UploadsService) private readonly uploads:UploadsService) {}

  private async row(id:string,lock=false,expiredOnly=false):Promise<PlanRow> {
    if (!UUID.test(id)) throw new BadRequestException('Identificador de importação inválido.');
    const row = await this.db.get<PlanRow>('SELECT p.* FROM proof_import_plans p JOIN core_simulado s ON s.id=p.simulado_id WHERE p.id=? AND s.owner_id=?' + (lock && this.db.dialect === 'postgres' ? ' FOR UPDATE OF p' : ''),id,accountId());
    if (!row) throw new NotFoundException('Importação não encontrada.');
    if (!expiredOnly) await this.simulados.get(row.simulado_id);
    return row;
  }
  private alive(plan:PlanRow) {
    if (!Number.isFinite(Date.parse(plan.expira_em)) || Date.parse(plan.expira_em) <= Date.now()) throw new BadRequestException('Esta importação expirou. Envie os arquivos novamente; correções já salvas permanecem no simulado.');
  }
  private async pages(id:string):Promise<PageRow[]> { return this.db.all<PageRow>('SELECT * FROM proof_import_pages WHERE plan_id=? ORDER BY file_index,page_number',id); }
  private async currentKey(simuladoId:number) {
    const simulado=await this.simulados.get(simuladoId),count=questionCount(simulado.total_questoes);
    if (!simulado.gabarito_oficial || Object.keys(simulado.gabarito_oficial).length !== count || invalidQuestions(simulado.gabarito_oficial,count).length) throw new BadRequestException('Revise o gabarito oficial completo antes de importar as provas.');
    return {key:simulado.gabarito_oficial,count,key_hash:fingerprint(simulado.gabarito_oficial,count)};
  }
  private checkFile(name:string,size:number) {
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\x00-\x1f]/.test(name) || !ALLOWED_EXTENSIONS.includes(extname(name).toLowerCase())) throw new BadRequestException('Use PDFs ou imagens com nomes válidos de até 255 caracteres.');
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_SIZE) throw new BadRequestException('Cada arquivo deve conter até 20 MB.');
  }
  private async withSource<T>(file:SourceFile,work:(path:string)=>Promise<T>):Promise<T> {
    // The remote Python worker receives a short-lived private URL, without another upload or local download.
    if (!this.storage.privateCloud || OMR_REMOTE_URL) return work(join(MEDIA_ROOT,file.key));
    const content=await this.storage.get(file.key,file.size);
    if (content.buffer.length !== file.size) throw new BadRequestException('O arquivo guardado mudou de tamanho. Envie uma nova cópia.');
    const directory=join(MEDIA_ROOT,'.staging');await mkdir(directory,{recursive:true});
    const path=join(directory,randomUUID()+extname(file.name).toLowerCase());
    try {await writeFile(path,content.buffer);return await work(path);} finally {await rm(path,{force:true});}
  }
  private async countFiles(files:SourceFile[]):Promise<void> {
    let total=0;
    for (const file of files) {
      const info=await this.withSource(file,path=>this.omr.documentInfo(path,file.key));
      if (!info || !Number.isSafeInteger(info.page_count) || info.page_count < 1) throw new BadRequestException('O processador não confirmou a quantidade de páginas do documento.');
      file.pages=info.page_count;total+=info.page_count;
      if (total>MAX_PAGES) throw new BadRequestException('Cada importação aceita até 100 páginas no total. Divida o PDF ou envie menos arquivos. Nenhuma página será descartada silenciosamente.');
    }
  }
  private async savePlan(simuladoId:number,files:SourceFile[],snapshot:Awaited<ReturnType<ProofImportService['currentKey']>>):Promise<string> {
    const id=randomUUID(),now=new Date(),expiry=new Date(now.getTime()+2*60*60*1000).toISOString();
    await this.db.transaction(async()=>{
      if ((await this.currentKey(simuladoId)).key_hash !== snapshot.key_hash) throw new BadRequestException('O gabarito mudou durante a preparação. Envie os arquivos novamente.');
      await this.db.run('INSERT INTO proof_import_plans(id,simulado_id,payload,estado,criado_em,expira_em) VALUES(?,?,?,?,?,?)',id,simuladoId,JSON.stringify({files,...snapshot} satisfies PlanPayload),'PREVIA',now.toISOString(),expiry);
      for (let index=0;index<files.length;index++) for(let page=1;page<=files[index].pages;page++) await this.db.run('INSERT INTO proof_import_pages(id,plan_id,file_index,page_number) VALUES(?,?,?,?)',randomUUID(),id,index,page);
    });
    return id;
  }
  async prepareLocal(simuladoId:number,files:Express.Multer.File[]):Promise<ProofImportPlan> {
    const saved:SourceFile[]=[];let committed=false;
    try {
      const snapshot=await this.currentKey(simuladoId);
      if (!Array.isArray(files) || !files.length || files.length>50) throw new BadRequestException('Selecione de 1 a 50 arquivos por importação.');
      for(const file of files) {
        this.checkFile(file.originalname,file.size);
        const key='importing/'+randomUUID()+extname(file.originalname).toLowerCase();
        const content=await readFile(file.path);
        if(content.length!==file.size) throw new BadRequestException('O tamanho de um arquivo recebido não corresponde ao informado.');
        saved.push({name:file.originalname.trim(),key,size:file.size,pages:0});
        await this.storage.put(key,content,contentType(file.originalname));
      }
      await this.countFiles(saved);const id=await this.savePlan(simuladoId,saved,snapshot);committed=true;return this.get(id);
    } finally {
      await Promise.all((Array.isArray(files) ? files : []).map(file=>rm(file.path,{force:true}).catch(()=>undefined)));
      if(!committed) await Promise.all(saved.map(file=>this.storage.remove(file.key).catch(()=>undefined)));
    }
  }
  async prepareStored(simuladoId:number,uploadIds:unknown):Promise<ProofImportPlan> {
    const snapshot=await this.currentKey(simuladoId),receipts=await this.uploads.claimProofs(uploadIds);
    const saved:SourceFile[]=receipts.map(receipt=>({name:receipt.name,key:receipt.path,size:receipt.size,pages:0}));let committed=false;
    try {
      for(const file of saved) {
        this.checkFile(file.name,file.size);
        const content=await this.storage.get(file.key,file.size);
        if(content.buffer.length!==file.size) throw new BadRequestException('O arquivo recebido tem um tamanho diferente do informado. Envie-o novamente.');
      }
      await this.countFiles(saved);const id=await this.savePlan(simuladoId,saved,snapshot);committed=true;return this.get(id);
    } finally {if(!committed) await Promise.all(saved.map(file=>this.storage.remove(file.key).catch(()=>undefined)));}
  }
  async get(id:string):Promise<ProofImportPlan> {
    const plan=await this.row(id),payload=JSON.parse(plan.payload) as PlanPayload,pages=await this.pages(id);
    return {id:plan.id,simulado_id:Number(plan.simulado_id),estado:plan.estado,criado_em:plan.criado_em,expira_em:plan.expira_em,
      total_arquivos:payload.files.length,total_paginas:pages.length,total_identificadas:pages.filter(page=>page.identity!==null).length,
      total_concluidas:pages.filter(page=>page.estado==='CONCLUIDA' || page.estado==='IGNORADA').length,envio_id:plan.envio_id === null ? null : Number(plan.envio_id),
      paginas:pages.map(page=>{
        const identity=page.identity ? JSON.parse(page.identity) as DocumentIdentity : null;
        return {id:page.id,arquivo:payload.files[page.file_index].name,arquivo_indice:Number(page.file_index),pagina:Number(page.page_number),
          matricula_detectada:identity?.matricula_detectada || null,matricula:page.matricula,identificacao:identity?.matricula_status || 'PENDENTE',fonte:identity?.matricula_fonte || '',
          candidatas:identity?.matricula_candidatas || [],mensagem:identity?.erro_msg || '',estado:page.estado,resultado_id:page.resultado_id === null ? null : Number(page.resultado_id)};
      })};
  }
  async list(simuladoId:number):Promise<{importacoes:ProofImportPlan[]}> {
    await this.simulados.get(simuladoId);await this.cleanupExpired();
    const rows=await this.db.all<{id:string}>('SELECT id FROM proof_import_plans WHERE simulado_id=? AND estado<>? AND expira_em>? ORDER BY criado_em DESC LIMIT 10',simuladoId,'CONCLUIDA',new Date().toISOString());
    return {importacoes:await Promise.all(rows.map(row=>this.get(row.id)))};
  }
  private identity(value:unknown,pageNumber:number):DocumentIdentity {
    if(!value || typeof value!=='object' || Array.isArray(value)) throw new ServiceUnavailableException('A identificação retornou dados inválidos. Tente novamente.');
    const row=value as DocumentIdentity;
    if(row.page_number!==pageNumber || !['CONFIRMADA','AUSENTE','AMBIGUA','INCERTA'].includes(row.matricula_status)
      || ![null,'pdf_texto','ocr'].includes(row.matricula_fonte) || !Array.isArray(row.matricula_candidatas) || row.matricula_candidatas.length>30
      || row.matricula_candidatas.some(candidate=>!validId(candidate)) || new Set(row.matricula_candidatas).size!==row.matricula_candidatas.length
      || (row.matricula_detectada!==null && !validId(row.matricula_detectada)) || typeof row.erro_msg!=='string' || row.erro_msg.length>10000 || row.erro_msg.includes('\x00')
      || (row.matricula_status==='CONFIRMADA' && (!row.matricula_detectada || !row.matricula_fonte || !row.matricula_candidatas.includes(row.matricula_detectada)))) throw new ServiceUnavailableException('A identificação não confirmou os índices e as matrículas das páginas solicitadas. Tente novamente.');
    return {page_number:pageNumber,matricula_detectada:row.matricula_detectada,matricula_status:row.matricula_status,matricula_fonte:row.matricula_fonte,matricula_candidatas:row.matricula_candidatas,erro_msg:row.erro_msg};
  }
  private inspected(result:DocumentInspection,expected:PageRow[],file:SourceFile):DocumentIdentity[] {
    if(!result || result.page_count!==file.pages || !Array.isArray(result.pages) || result.pages.length!==expected.length) throw new ServiceUnavailableException('A identificação retornou uma quantidade inesperada de páginas. Tente novamente.');
    const numbers=result.pages.map(page=>page.page_number);
    if(new Set(numbers).size!==numbers.length || expected.some(page=>!numbers.includes(page.page_number))) throw new ServiceUnavailableException('A identificação retornou páginas diferentes das solicitadas. Tente novamente.');
    return expected.map(page=>this.identity(result.pages.find(identity=>identity.page_number===page.page_number),page.page_number));
  }
  async identify(id:string):Promise<ProofImportPlan> {
    const plan=await this.row(id);this.alive(plan);
    if(plan.estado!=='PREVIA') throw new BadRequestException('A identificação só pode ser feita antes da confirmação das matrículas.');
    const pages=await this.pages(id),first=pages.find(page=>page.identity===null && page.estado==='PENDENTE');
    if(!first) return this.get(id);
    const selected=pages.filter(page=>page.file_index===first.file_index && page.identity===null && page.estado==='PENDENTE').slice(0,3);
    const file=(JSON.parse(plan.payload) as PlanPayload).files[first.file_index];
    let result:DocumentInspection;
    try {result=await this.withSource(file,path=>this.omr.inspectDocument(path,selected.map(page=>page.page_number),file.key));}
    catch {throw new ServiceUnavailableException('A identificação foi interrompida. As páginas pendentes foram preservadas; tente novamente.');}
    const identities=this.inspected(result,selected,file);
    await this.db.transaction(async()=>{
      const current=await this.row(id,true);this.alive(current);
      if(current.estado!=='PREVIA') throw new BadRequestException('A importação foi confirmada enquanto a identificação estava em andamento.');
      for(let index=0;index<selected.length;index++) await this.db.run('UPDATE proof_import_pages SET identity=?,matricula=? WHERE id=? AND plan_id=? AND identity IS NULL AND estado=?',JSON.stringify(identities[index]),identities[index].matricula_detectada || '',selected[index].id,id,'PENDENTE');
    });
    return this.get(id);
  }
  async confirm(id:string,rawPages:unknown,confirmation:unknown,allowDuplicates:unknown):Promise<ProofImportPlan> {
    if(confirmation!=='sim' || !Array.isArray(rawPages) || !rawPages.length || rawPages.length>MAX_PAGES) throw new BadRequestException('Revise todas as páginas e confirme as matrículas antes de corrigir.');
    await this.db.transaction(async()=>{
      const plan=await this.row(id,true);this.alive(plan);
      if(plan.estado!=='PREVIA') throw new BadRequestException('Esta importação já foi confirmada. Retome o processamento existente.');
      const pages=await this.pages(id),payload=JSON.parse(plan.payload) as PlanPayload;
      if(rawPages.length!==pages.length) throw new BadRequestException('Inclua uma decisão explícita para cada página da prévia.');
      const seen=new Set<string>(),identifiers=new Set<string>();let included=0;
      const decisions=rawPages.map(value=>{
        if(!value || typeof value!=='object' || Array.isArray(value)) throw new BadRequestException('Decisão de página inválida.');
        const entry=value as {id?:unknown;incluir?:unknown;matricula?:unknown};
        const page=pages.find(row=>row.id===entry.id);
        if(!page || typeof entry.id!=='string' || seen.has(entry.id) || typeof entry.incluir!=='boolean') throw new BadRequestException('As decisões devem conter páginas distintas pertencentes a esta importação.');
        seen.add(entry.id);
        if(!entry.incluir) return {page,incluir:false,matricula:''};
        if(!page.identity) throw new BadRequestException('Identifique cada página incluída antes de confirmar; páginas fora da importação devem ser excluídas explicitamente.');
        this.identity(JSON.parse(page.identity),page.page_number);
        if(!validId(entry.matricula)) throw new BadRequestException('Informe uma matrícula de 1 a 100 caracteres, sem caracteres de controle, para cada página incluída.');
        const matricula=entry.matricula.trim();
        if(identifiers.has(matricula) && allowDuplicates!=='sim') throw new BadRequestException('Há matrículas repetidas entre as páginas. Confira as cópias e confirme explicitamente permitir matrículas repetidas.');
        identifiers.add(matricula);included++;return {page,incluir:true,matricula};
      });
      if(!included) throw new BadRequestException('Selecione pelo menos uma página para corrigir, ou cancele a importação.');
      if((await this.currentKey(Number(plan.simulado_id))).key_hash!==payload.key_hash) throw new BadRequestException('O gabarito ou a quantidade de questões mudou após a prévia. Prepare uma nova importação para revisar a correção.');
      const claim=await this.db.run('UPDATE proof_import_plans SET estado=? WHERE id=? AND estado=?','CONFIRMADA',id,'PREVIA');
      if(claim.changes!==1) throw new BadRequestException('A importação já foi confirmada. Retome o envio existente.');
      const batch=await this.db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)',new Date().toISOString(),Number(plan.simulado_id),JSON.stringify(payload.key));
      await this.db.run('UPDATE proof_import_plans SET envio_id=? WHERE id=?',Number(batch.lastInsertRowid),id);
      for(const decision of decisions) await this.db.run('UPDATE proof_import_pages SET matricula=?,estado=? WHERE id=? AND plan_id=?',decision.matricula,decision.incluir?'PRONTA':'IGNORADA',decision.page.id,id);
    });
    return this.get(id);
  }
  private async claim(id:string):Promise<{plan:PlanRow;page:PageRow;claimId:string}|null> {
    return this.db.transaction(async()=>{
      const plan=await this.row(id,true);this.alive(plan);
      if(plan.estado==='CONCLUIDA') return null;
      if(plan.estado!=='CONFIRMADA' || !plan.envio_id) throw new BadRequestException('Confirme as matrículas antes de iniciar a correção.');
      const cutoff=new Date(Date.now()-LEASE_MS).toISOString();
      await this.db.run('UPDATE proof_import_pages SET estado=?,claim_id=NULL,claim_at=NULL WHERE plan_id=? AND estado=? AND (claim_at IS NULL OR claim_at<=?)','PRONTA',id,'PROCESSANDO',cutoff);
      const page=await this.db.get<PageRow>('SELECT * FROM proof_import_pages WHERE plan_id=? AND estado=? ORDER BY file_index,page_number LIMIT 1',id,'PRONTA');
      if(!page) return null;
      const claimId=randomUUID(),claimed=await this.db.run('UPDATE proof_import_pages SET estado=?,claim_id=?,claim_at=? WHERE id=? AND plan_id=? AND estado=?','PROCESSANDO',claimId,new Date().toISOString(),page.id,id,'PRONTA');
      if(claimed.changes!==1) return null;
      return {plan,page,claimId};
    });
  }
  private reading(value:OMRReading,count:number):OMRReading {
    if(!value || !['SUCESSO','ALERTA_RASURA','ALERTA_REVISAO','ERRO_LEITURA'].includes(value.status) || !value.respostas_detectadas || typeof value.respostas_detectadas!=='object' || Array.isArray(value.respostas_detectadas)
      || typeof value.erro_msg!=='string' || value.erro_msg.length>10000 || (value.debug_image_path!==null && typeof value.debug_image_path!=='string')) throw new ServiceUnavailableException('O processador não confirmou uma leitura válida.');
    if(value.status!=='ERRO_LEITURA' && (Object.keys(value.respostas_detectadas).length!==count || Array.from({length:count},(_,i)=>String(i+1)).some(number=>!['A','B','C','D','E','BNK','RAS','INC'].includes(value.respostas_detectadas[number])))) return {respostas_detectadas:{},status:'ERRO_LEITURA',debug_image_path:value.debug_image_path,erro_msg:'O processador retornou respostas incompletas ou inválidas. Confira uma cópia legível do cartão.'};
    return value;
  }
  private async finish(id:string):Promise<void> {
    const done=await this.db.transaction(async()=>{
      const plan=await this.row(id,true);
      const pending=await this.db.get<{total:number}>('SELECT COUNT(*) total FROM proof_import_pages WHERE plan_id=? AND estado NOT IN (?,?)',id,'CONCLUIDA','IGNORADA');
      if(plan.estado==='PREVIA' || Number(pending?.total)) return false;
      await this.db.run('UPDATE proof_import_plans SET estado=? WHERE id=?','CONCLUIDA',id);return true;
    });
    if(done) await this.cleanSources(id);
  }
  private async cleanSources(id:string):Promise<void> {
    const plan=await this.row(id),payload=JSON.parse(plan.payload) as PlanPayload;
    if(payload.cleaned) return;
    const removals=await Promise.allSettled(payload.files.map(file=>this.storage.remove(file.key)));
    if(removals.some(result=>result.status==='rejected')) return;
    await this.db.run('UPDATE proof_import_plans SET payload=? WHERE id=? AND estado=?',JSON.stringify({...payload,cleaned:true}),id,'CONCLUIDA');
  }
  async process(id:string):Promise<ProofImportPlan> {
    for(let step=0;step<2;step++) {
      const job=await this.claim(id);if(!job) break;
      const payload=JSON.parse(job.plan.payload) as PlanPayload,file=payload.files[job.page.file_index];
      const debugKey='debug_images/'+job.claimId+'_debug.png',debugPath=join(MEDIA_ROOT,debugKey);let debugStored=false,committed=false,preserveDebug=false;
      try {
        await mkdir(join(MEDIA_ROOT,'debug_images'),{recursive:true});
        const reading=this.reading(await this.withSource(file,path=>this.omr.process(path,payload.key,debugPath,payload.count,job.page.page_number,false,file.key)),payload.count);
        if(reading.debug_image_path) {
          const image=await readFile(debugPath);if(!image.length || image.length>MAX_FILE_SIZE) throw new ServiceUnavailableException('A imagem de conferência excedeu o tamanho permitido.');
          await this.storage.put(debugKey,image,'image/png');debugStored=true;
        }
        committed=await this.db.transaction(async()=>{
          const current=await this.row(id,true),page=await this.db.get<PageRow>('SELECT * FROM proof_import_pages WHERE id=? AND plan_id=?',job.page.id,id);
          if(current.estado!=='CONFIRMADA' || !page || page.estado!=='PROCESSANDO' || page.claim_id!==job.claimId) return false;
          const score=grade(reading.respostas_detectadas,payload.key,reading.status,payload.count),uncertain=Object.entries(reading.respostas_detectadas).filter(([,answer])=>answer==='INC').map(([number])=>number);
          const message=uncertain.length?'Nota provisória. Confira as questões '+uncertain.join(', ')+' e reenvie uma imagem mais nítida.':reading.erro_msg;
          const identity=page.identity ? JSON.parse(page.identity) as DocumentIdentity : null;
          const source=identity?.matricula_status==='CONFIRMADA' && identity.matricula_detectada===page.matricula ? identity.matricula_fonte || 'manual_revisada' : 'manual_revisada';
          const saved=await this.db.run(`INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,total_incertas,nota_percentual,imagem_debug,status,lote_id,mensagem_leitura,arquivo_origem,pagina_origem,matricula_fonte)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,page.matricula,JSON.stringify(reading.respostas_detectadas),score.total_acertos,score.total_erros,score.total_rasuras,score.total_brancos,score.total_incertas,score.nota_percentual,debugStored?debugKey:null,reading.status as ReadingStatus,Number(current.envio_id),message,file.name,page.page_number,source);
          const complete=await this.db.run('UPDATE proof_import_pages SET estado=?,resultado_id=?,claim_id=NULL,claim_at=NULL WHERE id=? AND plan_id=? AND estado=? AND claim_id=?','CONCLUIDA',Number(saved.lastInsertRowid),page.id,id,'PROCESSANDO',job.claimId);
          if(complete.changes!==1) throw new ServiceUnavailableException('A página mudou durante a correção. O resultado não foi salvo; retome a importação.');
          return true;
        });
      } catch {
        await this.db.run('UPDATE proof_import_pages SET estado=?,claim_id=NULL,claim_at=NULL WHERE id=? AND plan_id=? AND estado=? AND claim_id=?','PRONTA',job.page.id,id,'PROCESSANDO',job.claimId).catch(()=>undefined);
        // A lost COMMIT response may mean the result was saved. Never erase its durable mirror on uncertainty.
        if(debugStored) try {committed=!!await this.db.get<{id:number}>('SELECT id FROM core_resultadoaluno WHERE imagem_debug=?',debugKey);} catch {preserveDebug=true;}
        throw new ServiceUnavailableException('A correção foi interrompida. As páginas já concluídas permanecem salvas; retome a importação para continuar as pendentes.');
      } finally {
        if(!committed && debugStored && !preserveDebug) await this.storage.remove(debugKey).catch(()=>undefined);
        if(this.storage.privateCloud || (!committed && !preserveDebug)) await rm(debugPath,{force:true}).catch(()=>undefined);
      }
    }
    await this.finish(id);return this.get(id);
  }
  async source(id:string,index:number) {
    const plan=await this.row(id);this.alive(plan);const payload=JSON.parse(plan.payload) as PlanPayload;
    if(!Number.isSafeInteger(index) || index<0 || index>=payload.files.length) throw new BadRequestException('Índice de arquivo inválido.');
    if(payload.cleaned) throw new NotFoundException('Os arquivos temporários desta importação já foram removidos. As correções e imagens de conferência permanecem no simulado.');
    const file=payload.files[index],content=await this.storage.get(file.key,file.size);
    if(content.buffer.length!==file.size) throw new ServiceUnavailableException('O tamanho do arquivo original mudou.');
    return {...content,contentType:contentType(file.name),name:file.name};
  }
  private async removePlan(id:string,expiredOnly=false):Promise<boolean> {
    return this.db.transaction(async()=>{
      let plan:PlanRow;try {plan=await this.row(id,true,expiredOnly);} catch(error) {if(expiredOnly && error instanceof NotFoundException) return false;throw error;}
      if(expiredOnly && Date.parse(plan.expira_em)>Date.now()) return false;
      const active=await this.db.get<{total:number}>('SELECT COUNT(*) total FROM proof_import_pages WHERE plan_id=? AND estado=? AND claim_at>?',id,'PROCESSANDO',new Date(Date.now()-LEASE_MS).toISOString());
      if(Number(active?.total)) {if(expiredOnly) return false;throw new BadRequestException('Há páginas em processamento. Aguarde a chamada atual terminar antes de cancelar a importação.');}
      const payload=JSON.parse(plan.payload) as PlanPayload;
      await Promise.all(payload.files.map(file=>this.storage.remove(file.key)));
      await this.db.run('DELETE FROM proof_import_plans WHERE id=?',id);return true;
    });
  }
  async cancel(id:string):Promise<{message:string}> {await this.removePlan(id);return {message:'Importação cancelada e arquivos temporários removidos. As correções já salvas permanecem no simulado.'};}
  async cleanupAllExpired() {
    const rows=await this.db.all<{id:string;owner_id:string}>('SELECT p.id,s.owner_id FROM proof_import_plans p JOIN core_simulado s ON s.id=p.simulado_id WHERE p.expira_em<=? AND s.owner_id<>? ORDER BY p.expira_em LIMIT 20',new Date().toISOString(),'');
    let total=0;
    for (const row of rows) try {if(await withAccount({id:row.owner_id,email:''},()=>this.removePlan(row.id,true))) total++;} catch { /* Tenta novamente no próximo cron. */ }
    return {total};
  }
  async cleanupExpired():Promise<{total:number}> {
    const rows=await this.db.all<{id:string}>('SELECT p.id FROM proof_import_plans p JOIN core_simulado s ON s.id=p.simulado_id WHERE p.expira_em<=? AND s.owner_id=? ORDER BY p.expira_em LIMIT 20',new Date().toISOString(),accountId());let total=0;
    for(const row of rows) try {if(await this.removePlan(row.id,true)) total++;} catch { /* Retain the plan and source keys so a later cleanup can retry. */ }
    return {total};
  }
}
