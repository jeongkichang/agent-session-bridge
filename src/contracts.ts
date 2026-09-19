import { z } from 'zod';

export const MAX_TEXT_BYTES = 32 * 1024;
// One decoded byte can use six JSON bytes (for example a control character).
export const MAX_JSON_BYTES = MAX_TEXT_BYTES * 6 + 4096;
export const PEER_LEASE_MS = 45_000;
export const textSchema = z.string().min(1).refine((s) => Buffer.byteLength(s) <= MAX_TEXT_BYTES, 'Text exceeds 32 KiB');
export const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const idSchema = z.string().uuid();
export const registrationSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: z.enum(['codex', 'claude', 'client']),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const sendSchema = z.object({
  request_id: idSchema,
  peer_id: idSchema,
  text: textSchema,
  ttl_seconds: z.number().int().min(30).max(86_400).default(3600),
}).strict();
export const replySchema = z.object({
  request_id: idSchema,
  text: textSchema,
  outcome: z.enum(['completed', 'failed']).default('completed'),
}).strict();
export const terminalStates = new Set(['completed', 'failed', 'delivery_unknown', 'expired']);
export type RequestState = 'queued' | 'delivered' | 'acknowledged' | 'completed' | 'failed' | 'delivery_unknown' | 'expired';
export interface Peer {
  id: string;
  name: string;
  kind: 'codex' | 'claude' | 'client';
  online: boolean;
  last_seen_at: string;
}
export interface BridgeRequest {
  request_id: string;
  from: { id: string; name: string; kind: string };
  to: { id: string; name: string; kind: string };
  text: string;
  state: RequestState;
  created_at: string;
  expires_at: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
  finished_at: string | null;
  reply: string | null;
  reason: string | null;
  authority: 'external_ai_message';
  user_approval: false;
}
/**
 * 끝난 요청을 «보낸 쪽» 에게 알릴 때 싣는 모양 — 본문(`text`)과 회신(`reply`)이 «없다».
 * 알림은 「꺼내 가라」는 신호이고, 내용은 요청 조회로 읽는다.
 */
export type ReplyNotice = Omit<BridgeRequest, 'text' | 'reply'> & { has_reply: boolean };
export class BridgeError extends Error {
  constructor(public code: string, public status = 400, message = code) {
    super(message);
  }
}
