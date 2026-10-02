import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateContent = vi.fn();

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContent };
    }
  };
});

import { ApiError, FinishReason } from '@google/genai';
import { resetModelCooldowns, restructureWithGemini } from './gemini.js';
import { RestructureError } from './restructure.js';

const input = { title: 'Backup', tag: 'PROCEDIMIENTOS', content: 'copiar la bd' };

describe('restructureWithGemini', () => {
  beforeEach(() => {
    generateContent.mockReset();
    resetModelCooldowns();
  });

  it('devuelve el texto y envía prompt de sistema por categoría', async () => {
    generateContent.mockResolvedValue({ text: '  OBJETIVO\n1. Copiar la BD ', candidates: [{ finishReason: FinishReason.STOP }] });
    await expect(restructureWithGemini(input)).resolves.toBe('OBJETIVO\n1. Copiar la BD');

    const call = generateContent.mock.calls[0]![0];
    expect(call.contents).toContain('<contenido>');
    expect(call.config.systemInstruction).toContain('PROCEDIMIENTO');
  });

  it('informa cuando la nota es demasiado larga', async () => {
    generateContent.mockResolvedValue({ text: 'parcial', candidates: [{ finishReason: FinishReason.MAX_TOKENS }] });
    await expect(restructureWithGemini(input)).rejects.toMatchObject({ status: 413 });
  });

  it('informa cuando la IA bloquea el contenido', async () => {
    generateContent.mockResolvedValue({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] });
    await expect(restructureWithGemini(input)).rejects.toMatchObject({ status: 422 });
  });

  it('rechaza respuestas vacías', async () => {
    generateContent.mockResolvedValue({ text: '', candidates: [{ finishReason: FinishReason.STOP }] });
    await expect(restructureWithGemini(input)).rejects.toMatchObject({ status: 502 });
  });

  it('si el modelo está saturado reintenta y usa un modelo de respaldo', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    generateContent
      .mockRejectedValueOnce(new ApiError({ message: 'busy', status: 503 }))
      .mockRejectedValueOnce(new ApiError({ message: 'busy', status: 503 }))
      .mockResolvedValueOnce({ text: 'OK del respaldo', candidates: [{ finishReason: FinishReason.STOP }] });

    const promise = restructureWithGemini(input);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('OK del respaldo');
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(generateContent.mock.calls[2]![0].model).not.toBe(generateContent.mock.calls[0]![0].model);
    vi.useRealTimers();
  });

  it('si un modelo no tiene cuota (429) o fue retirado (404) pasa al siguiente sin esperar', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    generateContent
      .mockRejectedValueOnce(new ApiError({ message: 'quota', status: 429 }))
      .mockRejectedValueOnce(new ApiError({ message: 'gone', status: 404 }))
      .mockResolvedValueOnce({ text: 'OK del tercero', candidates: [{ finishReason: FinishReason.STOP }] });

    await expect(restructureWithGemini(input)).resolves.toBe('OK del tercero');
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it('si una llamada se cuelga o falla la red, prueba el siguiente modelo', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    generateContent
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockResolvedValueOnce({ text: 'OK tras el timeout', candidates: [{ finishReason: FinishReason.STOP }] });

    await expect(restructureWithGemini(input)).resolves.toBe('OK tras el timeout');
    expect(generateContent.mock.calls[0]![0].config.httpOptions.timeout).toBeGreaterThan(0);
  });

  it('usa nivel de razonamiento mínimo y cae a LOW si el modelo no lo admite', async () => {
    generateContent
      .mockRejectedValueOnce(new ApiError({ message: 'Thinking level MINIMAL is not supported for this model', status: 400 }))
      .mockResolvedValueOnce({ text: 'OK con LOW', candidates: [{ finishReason: FinishReason.STOP }] });

    await expect(restructureWithGemini(input)).resolves.toBe('OK con LOW');
    expect(generateContent.mock.calls[0]![0].config.thinkingConfig.thinkingLevel).toBe('MINIMAL');
    expect(generateContent.mock.calls[1]![0].config.thinkingConfig.thinkingLevel).toBe('LOW');
    // mismo modelo: no hizo falta cambiar
    expect(generateContent.mock.calls[1]![0].model).toBe(generateContent.mock.calls[0]![0].model);
  });

  it('si todos los modelos agotan la cuota informa el límite de uso', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    generateContent.mockImplementation(async () => { throw new ApiError({ message: 'quota', status: 429 }); });
    await expect(restructureWithGemini(input)).rejects.toMatchObject({ status: 429 });
  });

  it('una clave inválida no prueba otros modelos', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    generateContent.mockImplementation(async () => { throw new ApiError({ message: 'API key not valid', status: 403 }); });
    const error = await restructureWithGemini(input).catch(e => e);
    expect(error).toBeInstanceOf(RestructureError);
    expect(error.status).toBe(503);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('recuerda los modelos sin cuota y los salta en la siguiente solicitud', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    generateContent
      .mockRejectedValueOnce(new ApiError({ message: 'quota', status: 429 }))
      .mockResolvedValueOnce({ text: 'primera', candidates: [{ finishReason: FinishReason.STOP }] })
      .mockResolvedValueOnce({ text: 'segunda', candidates: [{ finishReason: FinishReason.STOP }] });

    await restructureWithGemini(input);
    await restructureWithGemini(input);

    const models = generateContent.mock.calls.map(c => c[0].model);
    expect(models).toHaveLength(3);
    // la segunda solicitud empieza directamente en el modelo que sí respondió, no en el que estaba sin cuota
    expect(models[2]).toBe(models[1]);
    expect(models[2]).not.toBe(models[0]);
  });
});
