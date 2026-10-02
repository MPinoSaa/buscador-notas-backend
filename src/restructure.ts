import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import type { Example } from './examples.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';

export interface RestructureInput {
  title: string;
  content: string;
  tag: string;
  examples?: Example[];
}

export type Restructurer = (input: RestructureInput) => Promise<string>;

export class RestructureError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let client: Anthropic | undefined;

// Usa ANTHROPIC_API_KEY del entorno
export const restructureWithClaude: Restructurer = async ({ title, content, tag, examples }) => {
  client ??= new Anthropic();
  try {
    const response = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 16000,
      system: buildSystemPrompt(tag, examples),
      messages: [{ role: 'user', content: buildUserPrompt(title, content) }]
    });

    if (response.stop_reason === 'refusal') {
      throw new RestructureError('La IA no pudo procesar esta nota.', 422);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new RestructureError('La nota es demasiado larga para reestructurarla.', 413);
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
    if (!text) throw new RestructureError('La IA devolvió una respuesta vacía.', 502);
    return text;
  } catch (error) {
    if (error instanceof RestructureError) throw error;
    if (error instanceof Anthropic.RateLimitError) {
      throw new RestructureError('La IA está saturada. Intenta de nuevo en un momento.', 429);
    }
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('ANTHROPIC_API_KEY inválida o ausente');
      throw new RestructureError('El servicio de IA no está configurado correctamente.', 503);
    }
    console.error('Error llamando a Claude:', error);
    throw new RestructureError('No se pudo reestructurar la nota.', 502);
  }
};
