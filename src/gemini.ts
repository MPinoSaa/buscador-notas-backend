import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { config } from './config.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { RestructureError, type RestructureInput, type Restructurer } from './restructure.js';

let client: GoogleGenAI | undefined;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Cada llamada tiene un tiempo máximo: sin esto, una conexión colgada deja esperando al usuario por minutos
const REQUEST_TIMEOUT_MS = 45_000;

const statusOf = (error: unknown) => (error instanceof ApiError ? error.status : undefined);

// Errores de ESTE modelo (saturado, sin cuota, retirado, lento o sin red): conviene probar con el siguiente.
// 400/401/403 son de configuración (clave, solicitud) y no se arreglan cambiando de modelo.
const isModelProblem = (error: unknown) => {
  const status = statusOf(error);
  return status === undefined || status === 503 || status === 429 || status === 404 || status >= 500;
};

async function generate(model: string, thinkingLevel: ThinkingLevel, { title, content, tag, examples }: RestructureInput) {
  client ??= new GoogleGenAI({ apiKey: process.env['GEMINI_API_KEY'] });
  return client.models.generateContent({
    model,
    contents: buildUserPrompt(title, content),
    config: {
      systemInstruction: buildSystemPrompt(tag, examples),
      maxOutputTokens: 16000,
      temperature: 0.2,
      // Reestructurar texto no necesita razonamiento profundo: el nivel mínimo responde en ~1 s en vez de ~8 s
      thinkingConfig: { thinkingLevel },
      httpOptions: { timeout: REQUEST_TIMEOUT_MS }
    }
  });
}

// Algunos modelos no admiten el nivel MINIMAL: se reintenta con LOW
async function generateWithThinking(model: string, input: RestructureInput) {
  try {
    return await generate(model, ThinkingLevel.MINIMAL, input);
  } catch (error) {
    if (statusOf(error) === 400 && /thinking level/i.test(String((error as Error).message))) {
      return generate(model, ThinkingLevel.LOW, input);
    }
    throw error;
  }
}

// Modelos sin cuota (429) o retirados (404): se saltan durante un rato en vez de fallar en cada solicitud.
// La cuota gratuita por minuto se renueva rápido; la diaria, al día siguiente.
const cooldownUntil = new Map<string, number>();
const COOLDOWN_MS: Record<number, number> = { 429: 5 * 60_000, 404: 60 * 60_000 };
export const resetModelCooldowns = () => cooldownUntil.clear();

// Prueba los modelos en orden. Si uno está saturado, sin cuota, retirado o lento, pasa al siguiente.
async function generateWithFallback(input: RestructureInput) {
  const all = [config.geminiModel, ...config.geminiFallbackModels];
  const now = Date.now();
  const available = all.filter(model => (cooldownUntil.get(model) ?? 0) <= now);
  const models = available.length > 0 ? available : all; // si todos están en pausa, se intenta igual
  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await generateWithThinking(model, input);
      } catch (error) {
        lastError = error;
        if (!isModelProblem(error)) throw error;
        // Solo la saturación momentánea (503) merece un segundo intento con el mismo modelo
        if (statusOf(error) !== 503 || attempt === 1) break;
        await sleep(1500);
      }
    }
    const pause = COOLDOWN_MS[statusOf(lastError) ?? 0];
    if (pause) cooldownUntil.set(model, Date.now() + pause);
    console.warn(`Gemini: el modelo ${model} no respondió (${statusOf(lastError) ?? 'sin respuesta'}), probando el siguiente...`);
  }
  throw lastError;
}

// Usa GEMINI_API_KEY del entorno (Google AI Studio)
export const restructureWithGemini: Restructurer = async (input) => {
  try {
    const response = await generateWithFallback(input);

    if (response.promptFeedback?.blockReason) {
      throw new RestructureError('La IA no pudo procesar esta nota.', 422);
    }
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === FinishReason.MAX_TOKENS) {
      throw new RestructureError('La nota es demasiado larga para reestructurarla.', 413);
    }
    if (finishReason === FinishReason.SAFETY || finishReason === FinishReason.PROHIBITED_CONTENT) {
      throw new RestructureError('La IA no pudo procesar esta nota.', 422);
    }

    const text = response.text?.trim();
    if (!text) throw new RestructureError('La IA devolvió una respuesta vacía.', 502);
    return text;
  } catch (error) {
    if (error instanceof RestructureError) throw error;
    const status = statusOf(error);
    if (status === 429) {
      throw new RestructureError('Se alcanzó el límite de uso gratuito de la IA. Intenta de nuevo en un minuto.', 429);
    }
    if (status === 503) {
      throw new RestructureError('La IA está con mucha demanda en este momento. Intenta de nuevo en unos segundos.', 503);
    }
    if (status === 400 || status === 401 || status === 403) {
      console.error('Gemini rechazó la solicitud (¿GEMINI_API_KEY inválida o sin permiso?):', (error as Error).message);
      throw new RestructureError('El servicio de IA no está configurado correctamente.', 503);
    }
    if (status === 404) {
      console.error(`Ningún modelo de Gemini disponible. Revisa GEMINI_MODEL y GEMINI_FALLBACK_MODELS.`);
      throw new RestructureError('El servicio de IA no está configurado correctamente.', 503);
    }
    console.error('Error llamando a Gemini:', error);
    throw new RestructureError('La IA tardó demasiado o no respondió. Intenta de nuevo.', 504);
  }
};
