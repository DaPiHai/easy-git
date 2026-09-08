import { zhCN, type MessageKey } from './zh-CN';

type Dictionary = Record<MessageKey, string>;

const dictionaries: Record<string, Dictionary> = {
  'zh-CN': zhCN,
};

let currentLocale = 'zh-CN';

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  let text: string = dictionaries[currentLocale][key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

export function setLocale(locale: string): void {
  currentLocale = locale;
}

export function getLocale(): string {
  return currentLocale;
}

export type { MessageKey };
