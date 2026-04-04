import type { Language } from "./config.ts";
import enStrings from "../locales/en.json";
import ptBrStrings from "../locales/pt-BR.json";

type StringMap = Record<string, string>;

const locales: Record<Language, StringMap> = {
  en: enStrings as StringMap,
  "pt-BR": ptBrStrings as StringMap,
};

let currentLanguage: Language = "en";

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
}

export function getLanguage(): Language {
  return currentLanguage;
}

/**
 * Translate a key to the current locale string.
 * Falls back to English, then to the key itself.
 */
export function t(key: string): string {
  const map = locales[currentLanguage];
  if (map[key] !== undefined) return map[key] as string;

  // Fallback to English
  const en = locales["en"];
  if (en[key] !== undefined) return en[key] as string;

  return key;
}
