// Oculta datos sensibles (contraseñas, tokens, llaves privadas, IPs) antes de enviar texto a la IA.
// Cada dato se cambia por un marcador estable (<IP_1>, <SECRET_2>) y luego se restaura en la respuesta,
// así la IA reordena la nota sin llegar a ver los valores reales.

export interface Redactor {
  redact(text: string): string;
  restore(text: string): string;
  /** Datos originales cuyo marcador no aparece en `text` (la IA los omitió) */
  missingFrom(text: string): string[];
  readonly count: number;
}

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
// usuario:contraseña@host dentro de una URL (solo se oculta la contraseña)
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi;
const KNOWN_TOKENS = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // claves de Google
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-[A-Za-z0-9_-]{20,}\b/g
];
// "contraseña: valor", "password = valor", "la clave es valor"
const KEY_VALUE =
  /\b(contrase(?:ñ|n)a|clave|password|passwd|pwd|pass|token|secret|api[_ -]?key|llave|credencial(?:es)?)\b(\s*(?:[:=]|->)\s*|\s+(?:es|is)\s+)("[^"\n]+"|'[^'\n]+'|[^\s,;]+)/gi;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

const isPlaceholder = (value: string) => /^<[A-Z]+_(?:[A-Z]+_)?\d+>$/.test(value);

/** `namespace` evita choques entre los marcadores de la nota y los de los ejemplos */
export function createRedactor(namespace = ''): Redactor {
  const placeholderByValue = new Map<string, string>();
  const valueByPlaceholder = new Map<string, string>();
  const counters = new Map<string, number>();

  const mask = (kind: string, value: string): string => {
    const key = `${kind}\u0000${value}`;
    const known = placeholderByValue.get(key);
    if (known) return known;
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    const placeholder = `<${kind}_${namespace ? namespace + '_' : ''}${n}>`;
    placeholderByValue.set(key, placeholder);
    valueByPlaceholder.set(placeholder, value);
    return placeholder;
  };

  return {
    redact(text) {
      let out = text.replace(PRIVATE_KEY, m => mask('LLAVE', m));
      out = out.replace(URL_CREDENTIALS, (_m, head: string, pass: string, at: string) =>
        isPlaceholder(pass) ? _m : head + mask('SECRET', pass) + at
      );
      for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, m => mask('SECRET', m));
      out = out.replace(KEY_VALUE, (full, word: string, sep: string, raw: string) => {
        const trailing = /^["']/.test(raw) ? '' : (raw.match(/[.)\]]+$/)?.[0] ?? '');
        const value = trailing ? raw.slice(0, -trailing.length) : raw;
        if (!value || isPlaceholder(value)) return full;
        return word + sep + mask('SECRET', value) + trailing;
      });
      return out.replace(IPV4, m => mask('IP', m));
    },

    restore(text) {
      let out = text;
      for (const [placeholder, value] of valueByPlaceholder) out = out.split(placeholder).join(value);
      return out;
    },

    missingFrom(text) {
      return [...valueByPlaceholder].filter(([placeholder]) => !text.includes(placeholder)).map(([, value]) => value);
    },

    get count() {
      return valueByPlaceholder.size;
    }
  };
}
