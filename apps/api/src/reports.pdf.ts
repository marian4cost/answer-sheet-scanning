import PDFDocument from 'pdfkit';
import type { StudentReport, ReportQuestion } from '@enem/shared/src/reports';
import { assetPath } from './assets';

const NAVY = '#18334f', BLUE = '#2563eb', INK = '#28384c', MUTED = '#657b97', LINE = '#d3dde8';
const AREA_COLORS = ['#2669d5', '#169678', '#8b5fc9', '#17865f'];
const LABEL: Record<ReportQuestion['resultado'], string> = {CORRETA:'CORRETA', INCORRETA:'INCORRETA', BRANCO:'BRANCO', DUPLA:'DUPLA', INCERTA:'INCERTA', PENDENTE:'PENDENTE'};
const STATE_FILL: Record<ReportQuestion['resultado'], string> = {CORRETA:'#e5f4ee', INCORRETA:'#fbecec', BRANCO:'#fff4dc', DUPLA:'#fff4dc', INCERTA:'#fff4dc', PENDENTE:'#edf1f6'};
const clean = (value: string) => value.replace(/[\u2010-\u2015]/g, '-').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const note = (value: number | null) => value === null ? 'Pendente' : value.toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
const answer = (value: string) => ({BNK:'-',RAS:'Dupla',INC:'Incerta','—':'-'}[value] || value);

/** Render from the reviewed result and historical answer key; never changes grading. */
export function renderReportPdf(report: StudentReport, institution: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({size:'A4', margin:46, bufferPages:true, info:{Title:`Boletim - ${clean(report.titulo)}`, Author:clean(institution)}});
    doc.registerFont('ReportRegular', assetPath('report-fonts/OpenSans-Regular.ttf'));
    doc.registerFont('ReportBold', assetPath('report-fonts/OpenSans-Bold.ttf'));
    const chunks: Buffer[] = []; doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const left = 46, width = doc.page.width - left * 2, bottom = doc.page.height - 70;
    let y = 64;
    const text = (value: string, x: number, top: number, w: number, size = 9, color = INK, bold = false, extra: PDFKit.Mixins.TextOptions = {}) => {
      doc.font(bold?'ReportBold':'ReportRegular').fontSize(size).fillColor(color).text(clean(value),x,top,{width:w,lineGap:2,...extra});
    };
    const height = (value: string, w = width, size = 9, bold = false) => doc.font(bold?'ReportBold':'ReportRegular').fontSize(size).heightOfString(clean(value),{width:w,lineGap:2});
    const band = () => {doc.rect(0,0,doc.page.width,43).fill(NAVY);text(institution,left,12,width,10,'#ffffff',true);};
    const newPage = () => {doc.addPage();band();y=64;};
    const ensure = (required: number) => {if (y + required > bottom) newPage();};
    const heading = (title: string, following = 10) => {ensure(22+following);text(title,left,y,width,12,NAVY,true);y+=22;};
    const boxParagraph = (value: string, fill: string, border: string, size = 9) => {
      const h=height(value,width-18,size)+18; ensure(h+10);doc.rect(left,y,width,h).fillAndStroke(fill,border);text(value,left+9,y+8,width-18,size);y+=h+12;
    };
    const paragraph = (value: string, size = 9, color = INK) => {
      // Split into lines before flowing, including long teacher feedback, so pages never clip.
      const paragraphs=clean(value).split('\n');
      const totalHeight=height(value,width,size);
      if (totalHeight < 80) ensure(totalHeight+8);
      for (const p of paragraphs) {
        if (!p) {ensure(13);y+=13;continue;}
        let line='';
        for (const word of p.split(/\s+/)) {
          const candidate=line?line+' '+word:word;
          if (doc.font('ReportRegular').fontSize(size).widthOfString(candidate)>width && line) {ensure(16);text(line,left,y,width,size,color);y+=16;line=word;}
          else line=candidate;
          // A pasted uninterrupted token must wrap too, rather than reaching the margin.
          while (doc.widthOfString(line)>width) {
            let n=line.length;while(n>1 && doc.widthOfString(line.slice(0,n))>width)n--;
            ensure(16);text(line.slice(0,n),left,y,width,size,color);y+=16;line=line.slice(n);
          }
        }
        if (line) {ensure(16);text(line,left,y,width,size,color);y+=16;}
      }
      y+=8;
    };
    band();
    text('BOLETIM INDIVIDUAL',left,y,width,9,BLUE,true);y+=17;
    const nameHeight=height(report.nome,width,20,true);text(report.nome,left,y,width,20,NAVY,true);y+=nameHeight+12;
    const meta=[['MATRÍCULA',report.matricula],['CURSO',report.curso || 'Não informado'],['AVALIAÇÃO',report.titulo]];
    const metaW=width/3, valueHeight=Math.max(...meta.map(([,v])=>height(v,metaW-12,9)));
    meta.forEach(([label,value],i)=>{const x=left+i*metaW;doc.rect(x,y,metaW,20).fillAndStroke('#f2f5f8',LINE);doc.rect(x,y+20,metaW,valueHeight+14).stroke(LINE);text(label,x+6,y+5,metaW-12,8,NAVY,true);text(value,x+6,y+26,metaW-12);});
    y+=valueHeight+43;
    heading('Resumo de desempenho');
    const cards=[...report.areas.map((area,i)=>({label:area.area,value:area.nota_dez,detail:area.total_questoes?`${area.total_acertos} acertos em ${area.total_questoes} questões`:'Sem questões nesta avaliação',color:AREA_COLORS[i]})),{label:'Resultado geral',value:report.nota_geral_dez,detail:`${report.geral.total_acertos} acertos em ${report.total_questoes} questões`,color:NAVY}];
    const gap=10,cardW=(width-gap*2)/3,cardH=68;
    ensure(cardH*2+gap+15);
    cards.forEach((card,i)=>{const x=left+(i%3)*(cardW+gap),top=y+Math.floor(i/3)*(cardH+gap);doc.rect(x,top,cardW,cardH).stroke(LINE);doc.rect(x,top,cardW,3).fill(card.color);text(card.label.toLocaleUpperCase('pt-BR'),x+8,top+9,cardW-16,7.8,NAVY,true);text(card.value===null && card.label!=='Resultado geral' && card.detail.startsWith('Sem')?'Sem questões':note(card.value)+(card.value===null?'':' / 10'),x+8,top+28,cardW-16,card.value===null?11:17,INK);text(card.detail,x+8,top+54,cardW-16,6.8,MUTED);});
    y+=cardH*2+gap+12;
    if (report.status==='ALERTA_REVISAO') paragraph('Nota provisória: existem respostas incertas que precisam ser revistas antes do envio.',8,'#9a6700');
    heading('Leitura do resultado',height(report.interpretacao,width-18,8.5)+28);boxParagraph(report.interpretacao,'#edf4ff','#bcd3ff',8.5);
    heading('Prioridades de revisão');
    const priorities=report.prioridades.filter(p=>p.incorretas.length || p.brancos.length || p.duplas.length || p.incertas.length);
    if (!priorities.length) paragraph(report.nota_geral_dez===null?'A correção precisa ser concluída para identificar as questões a revisar.':'Nenhuma resposta incorreta, em branco, dupla ou incerta foi identificada.',8);
    const priorityW=(width-gap)/2;
    for (let i=0;i<priorities.length;i+=2) {
      const row=priorities.slice(i,i+2).map(p=>({title:p.area,body:[p.incorretas.length?`Incorretas: ${p.incorretas.join(', ')}.`:'',p.brancos.length?`Em branco: ${p.brancos.join(', ')}.`:'',p.duplas.length?`Duplas: ${p.duplas.join(', ')}.`:'',p.incertas.length?`Incertas: ${p.incertas.join(', ')}.`:''].filter(Boolean).join(' ')}));
      const h=Math.max(...row.map(p=>height(p.body,priorityW-14,7.8)+height(p.title,priorityW-14,8,true)))+21;
      ensure(h+6);row.forEach((p,index)=>{const x=left+index*(priorityW+gap);doc.rect(x,y,priorityW,h).fillAndStroke('#f8fafc',LINE);text(p.title,x+7,y+6,priorityW-14,8,NAVY,true);text(p.body,x+7,y+height(p.title,priorityW-14,8,true)+10,priorityW-14,7.8);});y+=h+6;
    }
    y+=4;heading('Critério de correção',height(report.metodologia,width-18,7.5)+28);
    boxParagraph(report.metodologia,'#fff5df','#e9cf90',7.5);
    if (report.pendencias.length) {heading('Pendências');for (const p of report.pendencias) paragraph(p,8,'#9a6700');}
    if (report.avisos.length) {heading('Observações');for (const p of report.avisos) paragraph(p,8,MUTED);}
    // Keep the heading, total and competency row together when metadata pushes them near the footer.
    heading('Redação - avaliação do professor', report.redacao.competencias_redacao?.length === 5 ? 80 : 56);
    paragraph('Nota: '+(report.redacao.nota_redacao===null?'não informada pelo professor':`${report.redacao.nota_redacao} / 1000`),10,NAVY);
    if (report.redacao.competencias_redacao?.length === 5) {
      const cells = report.redacao.competencias_redacao;
      ensure(56);const cellW=width/5;
      cells.forEach((value,index)=>{const x=left+index*cellW;doc.rect(x,y,cellW,44).fillAndStroke('#f2f5f8',LINE);text(`COMPETÊNCIA ${index+1}`,x+5,y+6,cellW-10,7,NAVY,true);text(`${value} / 200`,x+5,y+24,cellW-10,10,INK);});
      y+=56;
    }
    if (report.redacao.avaliador_redacao) paragraph('Avaliador: '+report.redacao.avaliador_redacao,8,MUTED);
    if (report.redacao.situacao_redacao) paragraph('Situação do texto: '+report.redacao.situacao_redacao,8,MUTED);
    paragraph(report.redacao.feedback_redacao || 'Feedback ainda não informado pelo professor.');
    newPage();
    text('DETALHAMENTO DA CORREÇÃO',left,y,width,9,BLUE,true);y+=20;
    text('Questão por questão',left,y,width,21,NAVY,true);y+=37;
    text('Correta (verde) | incorreta (vermelho) | branco, dupla ou incerta (amarelo).',left,y,width,7.5,MUTED);y+=27;
    const half=Math.ceil(report.questoes.length/2),columnW=(width-gap)/2,cols=[report.questoes.slice(0,half),report.questoes.slice(half)];
    const table = (rows: ReportQuestion[], x: number, top: number) => {
      if (!rows.length) return;
      text(`Questões ${rows[0].numero} a ${rows.at(-1)!.numero}`,x,top,columnW,11,NAVY,true);top+=25;
      const fractions=[.17,.23,.24,.36],titles=['QUESTÃO','RESPOSTA','GABARITO','RESULTADO'];
      let cursor=x;
      titles.forEach((title,i)=>{const w=columnW*fractions[i];doc.rect(cursor,top,w,22).fillAndStroke(NAVY,'#ffffff');text(title,cursor+2,top+7,w-4,6.3,'#ffffff',true,{align:'center'});cursor+=w;});top+=22;
      for(const q of rows) {cursor=x;[String(q.numero),answer(q.resposta),answer(q.gabarito),LABEL[q.resultado]].forEach((v,i)=>{const w=columnW*fractions[i];doc.rect(cursor,top,w,17).fillAndStroke(i===3?STATE_FILL[q.resultado]:'#ffffff',LINE);text(v,cursor+2,top+4,w-4,7,NAVY,i===3,{align:'center'});cursor+=w;});top+=17;}
      return top;
    };
    const tableBottom=Math.max(...cols.map((rows,i)=>table(rows,left+i*(columnW+gap),y) || y));
    y=tableBottom+20;
    paragraph('Fonte: respostas identificadas no cartão e chave de correção registrada neste envio. Questões em branco e com marcação dupla não pontuam. Leituras incertas ou pendentes exigem revisão.',7.5,MUTED);
    const range=doc.bufferedPageRange();
    for(let i=range.start;i<range.start+range.count;i++) {
      doc.switchToPage(i);const fy=doc.page.height-42, oldBottom=doc.page.margins.bottom;doc.page.margins.bottom=0;
      doc.moveTo(left,fy-8).lineTo(left+width,fy-8).stroke(LINE);
      text(`Boletim #${report.resultado_id} | Escala objetiva: 0 a 10`,left,fy,width-70,7,MUTED,false,{lineBreak:false});
      text(`Página ${i+1}/${range.count}`,left+width-70,fy,70,7,MUTED,false,{align:'right',lineBreak:false});doc.page.margins.bottom=oldBottom;
    }
    doc.end();
  });
}
