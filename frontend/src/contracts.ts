import { z } from 'zod';

export const modeSchema = z.enum(['text', 'voice']);
export const languageSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  audio: z.boolean(),
});
const sessionSeconds = z.number().positive().max(240);

export const configSchema = z
  .object({
    languages: z.array(languageSchema).min(1),
    session_seconds: sessionSeconds,
    defaults: z.object({ language: z.string(), mode: modeSchema }),
  })
  .refine((value) =>
    value.languages.some(
      (language) =>
        language.code === value.defaults.language &&
        (value.defaults.mode === 'text' || language.audio),
    ),
  );

export const authSchema = z.object({ authenticated: z.boolean() });

export const turnSchema = z.object({
  id: z.string().min(1),
  replaces_id: z.string().optional(),
  speaker_id: z.union([z.number(), z.string()]).nullable(),
  source: z.string(),
  translation: z.string(),
  source_final: z.boolean(),
  translation_final: z.boolean(),
  final: z.boolean(),
  source_language: z.string().nullable(),
  audio_start_ms: z.number().nonnegative().nullable(),
});

export const serverEventSchema = z.discriminatedUnion('type', [
  turnSchema.extend({ type: z.literal('turn.update') }),
  z.object({
    type: z.literal('ready'),
    session_seconds: sessionSeconds,
    language: z.string(),
    mode: modeSchema,
  }),
  z.object({ type: z.literal('stopping'), reason: z.string() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('ended'), reason: z.string() }),
]);

export const captureEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('audio'),
    buffer: z.instanceof(ArrayBuffer),
    level: z.number().min(0).max(1),
  }),
  z.object({ type: z.literal('flushed') }),
]);

export type Mode = z.infer<typeof modeSchema>;
export type Language = z.infer<typeof languageSchema>;
export type Config = z.infer<typeof configSchema>;
export type Turn = z.infer<typeof turnSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
