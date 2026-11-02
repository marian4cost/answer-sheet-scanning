import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, GetPublicAccessBlockCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Só usa o prefixo dedicado. O bucket compartilhado nunca é criado ou alterado. */
export class S3Storage {
  private readonly client: S3Client;
  private readonly bucket = process.env.S3_BUCKET || '';
  private readonly prefix = process.env.S3_PREFIX || 'sirenia/';
  private ready?: Promise<void>;
  constructor() {
    if (!this.bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(this.bucket) || !/^(?:[a-zA-Z0-9_-]+\/)+$/.test(this.prefix)) throw new Error('Configure S3_BUCKET e S3_PREFIX com um prefixo exclusivo terminado em /.');
    // O corpo ainda não existe ao assinar o PUT. O SDK não pode assinar
    // antecipadamente o checksum de um corpo vazio no lugar da prova.
    this.client = new S3Client({region:process.env.S3_REGION || process.env.AWS_REGION,maxAttempts:3,requestChecksumCalculation:'WHEN_REQUIRED'});
  }
  private key(key:string) {
    if (!key || key.startsWith('/') || key.split('/').some(p=>!p || p==='.' || p==='..') || /[\\\x00-\x1f]/.test(key)) throw new InternalServerErrorException('Identificador de arquivo inválido.');
    return this.prefix + key;
  }
  private async ensurePrivate() {
    this.ready ??= (async()=>{
      const result = await this.client.send(new GetPublicAccessBlockCommand({Bucket:this.bucket}));
      const block = result.PublicAccessBlockConfiguration;
      if (!block?.BlockPublicAcls || !block.IgnorePublicAcls || !block.BlockPublicPolicy || !block.RestrictPublicBuckets) throw new Error('private bucket required');
    })();
    try {await this.ready;} catch {this.ready=undefined;throw new InternalServerErrorException('O S3 precisa dos quatro bloqueios de acesso público ativados e permissão para verificá-los.');}
  }
  async put(key:string, content:Buffer, contentType:string) {
    const Key=this.key(key); await this.ensurePrivate();
    await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key,Body:content,ContentType:contentType,IfNoneMatch:'*',ServerSideEncryption:'AES256'}));
  }
  async get(key:string,maxSize:number):Promise<{buffer:Buffer;contentType:string}> {
    const Key=this.key(key); await this.ensurePrivate();
    let response;
    try {response=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key}),{abortSignal:AbortSignal.timeout(30_000)});}
    catch(error) {if ((error as {name?:string}).name==='NoSuchKey' || (error as {$metadata?:{httpStatusCode:number}}).$metadata?.httpStatusCode===404) throw new NotFoundException('Arquivo não encontrado.'); throw new InternalServerErrorException('Não foi possível abrir o arquivo no S3.');}
    const body=response.Body;
    if (!body) throw new InternalServerErrorException('O arquivo não retornou conteúdo.');
    const stream=body as AsyncIterable<Uint8Array> & {destroy?:()=>void};
    if ((response.ContentLength || 0)>maxSize) {stream.destroy?.();throw new InternalServerErrorException('O arquivo excedeu o tamanho permitido.');}
    const chunks:Buffer[]=[];let size=0;
    try {for await (const chunk of stream) {size+=chunk.byteLength;if(size>maxSize) throw new InternalServerErrorException('O arquivo excedeu o tamanho permitido.');chunks.push(Buffer.from(chunk));}}
    finally {stream.destroy?.();}
    return {buffer:Buffer.concat(chunks,size),contentType:response.ContentType || 'application/octet-stream'};
  }
  async signedUploadURL(key:string) {
    const Key=this.key(key);await this.ensurePrivate();
    // O cliente envia If-None-Match também: a URL não pode substituir um objeto consumido.
    return getSignedUrl(this.client,new PutObjectCommand({Bucket:this.bucket,Key,IfNoneMatch:'*',ServerSideEncryption:'AES256'}),{expiresIn:900});
  }
  async signedDownloadURL(key:string,expiresIn:number) {
    const Key=this.key(key);await this.ensurePrivate();
    return getSignedUrl(this.client,new GetObjectCommand({Bucket:this.bucket,Key}),{expiresIn:Math.max(1,Math.min(expiresIn,900))});
  }
  async remove(key:string) {const Key=this.key(key);await this.ensurePrivate();await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key}));}
}
