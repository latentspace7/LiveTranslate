import type { Mode, Turn } from './contracts';
export type { Mode, Language, Config, Turn, ServerEvent } from './contracts';
export type Phase = 'idle' | 'preparing' | 'connecting' | 'listening' | 'finishing' | 'playing';
export type TranscriptSession = {
  id: string;
  started: string;
  language: string;
  languageName: string;
  mode: Mode;
  turns: Turn[];
  ended: boolean;
  reason?: string;
};
