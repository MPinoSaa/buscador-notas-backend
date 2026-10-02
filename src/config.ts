export const config = {
  // Carpeta donde se guardan los ejemplos aprobados (ignorada por git)
  dataDir: process.env.DATA_DIR ?? 'data',
  port: Number(process.env.PORT ?? 3000),
  // Proveedor de IA: "gemini" (por defecto) o "claude"
  aiProvider: (process.env.AI_PROVIDER ?? 'gemini').toLowerCase() as 'gemini' | 'claude',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash',
  // Modelos que se prueban en orden si el principal está saturado (503)
  geminiFallbackModels: (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-flash-latest,gemini-3.8-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.1-flash-lite,gemma-4-26b-a4b-it')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean),
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? 'buscador-notas',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:4200')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean),
  // Límite de contenido por nota (caracteres) para controlar el costo
  maxContentChars: 20_000
};
