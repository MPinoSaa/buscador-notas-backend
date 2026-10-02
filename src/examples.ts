import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Par "nota original -> resultado que el usuario aprobó". Sirve para que la IA imite el estilo del equipo.
export interface Example {
  tag: string;
  title: string;
  original: string;
  final: string;
  createdAt: string;
  by?: string;
}

// Interfaz pensada para poder cambiar el almacenamiento (por ejemplo a PostgreSQL) sin tocar el resto
export interface ExamplesStore {
  list(): Promise<Example[]>;
  /** Devuelve false si el ejemplo ya existía */
  add(example: Example): Promise<boolean>;
}

const sameExample = (a: Example, b: Example) => a.original === b.original && a.final === b.final;

export class FileExamplesStore implements ExamplesStore {
  constructor(private readonly file: string) {}

  async list(): Promise<Example[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return []; // aún no hay ejemplos
    }
    const examples: Example[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        examples.push(JSON.parse(line) as Example);
      } catch {
        // línea dañada: se ignora
      }
    }
    return examples;
  }

  async add(example: Example): Promise<boolean> {
    if ((await this.list()).some(e => sameExample(e, example))) return false;
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(example) + '\n', 'utf8');
    return true;
  }
}

export class MemoryExamplesStore implements ExamplesStore {
  readonly items: Example[] = [];
  async list() { return [...this.items]; }
  async add(example: Example) {
    if (this.items.some(e => sameExample(e, example))) return false;
    this.items.push(example);
    return true;
  }
}

// Elige los ejemplos más útiles: primero los de la misma categoría, más recientes primero,
// sin pasar del presupuesto de caracteres (para no encarecer ni alargar cada llamada).
export function selectExamples(all: Example[], tag: string, maxCount = 3, maxChars = 8000): Example[] {
  const wanted = tag.toUpperCase();
  const newestFirst = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const ordered = [
    ...newestFirst.filter(e => e.tag.toUpperCase() === wanted),
    ...newestFirst.filter(e => e.tag.toUpperCase() !== wanted)
  ];

  const chosen: Example[] = [];
  let used = 0;
  for (const example of ordered) {
    const size = example.original.length + example.final.length;
    if (chosen.length >= maxCount) break;
    if (used + size > maxChars) continue;
    chosen.push(example);
    used += size;
  }
  return chosen;
}
