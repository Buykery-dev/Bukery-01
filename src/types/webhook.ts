import { z } from 'zod';

/** Payload POSTed by Nanoclaw to /webhook/alert */
export const NanoclawAlertSchema = z.object({
  alertId:          z.string().optional(),
  serviceName:      z.string(),
  errorMessage:     z.string(),
  stackTrace:       z.string().optional(),
  recentLogs:       z.array(z.string()).default([]),
  deployVersion:    z.string().optional(),
  commitHash:       z.string().optional(),
  reproduceCommand: z.string().optional(),
  severity:         z.enum(['critical', 'high', 'medium', 'low']).optional(),
});

export type NanoclawAlertPayload = z.infer<typeof NanoclawAlertSchema>;

/** Payload POSTed after Codex finishes generating a patch */
export const CodexPatchCompleteSchema = z.object({
  issueId:      z.string(),
  patchTaskId:  z.string(),
  patchDiff:    z.string(),
  testCode:     z.string().optional(),
  explanation:  z.string(),
  filesChanged: z.array(z.string()),
  prUrl:        z.string().optional(),
  success:      z.boolean(),
  error:        z.string().optional(),
});

export type CodexPatchCompletePayload = z.infer<typeof CodexPatchCompleteSchema>;

/** Payload from Telegram button → /webhook/patch-decision */
export const PatchDecisionSchema = z.object({
  issueId:       z.string(),
  approved:      z.boolean(),
  approvedBy:    z.string().optional(),
  patchPrUrl:    z.string().optional(),
});

export type PatchDecisionPayload = z.infer<typeof PatchDecisionSchema>;

/** Generic Telegram command forwarded to /webhook/task */
export const TelegramTaskSchema = z.object({
  prompt:    z.string(),
  chatId:    z.number(),
  messageId: z.number().optional(),
});

export type TelegramTaskPayload = z.infer<typeof TelegramTaskSchema>;
