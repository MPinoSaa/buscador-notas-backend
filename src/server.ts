import path from 'node:path';
import { createApp } from './app.js';
import { verifyFirebaseToken } from './auth.js';
import { FileExamplesStore } from './examples.js';
import { config } from './config.js';
import { restructureWithGemini } from './gemini.js';
import { restructureWithClaude } from './restructure.js';

const usingClaude = config.aiProvider === 'claude';
const keyName = usingClaude ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';

if (!process.env[keyName]) {
  console.warn(`${keyName} no está definida: el endpoint de IA responderá con error. Revisa el archivo .env`);
}

const app = createApp({
  verifyToken: verifyFirebaseToken,
  examples: new FileExamplesStore(path.join(config.dataDir, 'examples.jsonl')),
  restructure: usingClaude ? restructureWithClaude : restructureWithGemini
});

app.listen(config.port, () => {
  const model = usingClaude ? config.anthropicModel : config.geminiModel;
  console.log(`Backend escuchando en http://localhost:${config.port} (IA: ${config.aiProvider}, modelo: ${model})`);
});
