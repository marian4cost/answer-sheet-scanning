import { createApplication } from './bootstrap';
import { API_PORT, API_HOST } from './config';
import { DatabaseService } from './database.service';
import { OmrService } from './omr.service';
async function main() {
  const app = await createApplication();
  await app.get(DatabaseService).health();
  const processor = await app.get(OmrService).health();
  if (!processor.ok) throw new Error('O processador de imagens está indisponível.');
  await app.listen(API_PORT, API_HOST);
  console.log(`NestJS: http://${API_HOST}:${API_PORT}/api | OpenCV ${processor.opencv}`);
}
main().catch(error => { console.error(error); process.exit(1); });
