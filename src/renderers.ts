/**
 * Mosaic — Lens Renderers
 *
 * Convert LensView data to string formats for LLM prompts.
 * Lenses decide WHAT to include. Renderers decide HOW to format it.
 */

import type { CtxMessage, LensView } from './types.js';

/** Options for rendering a lens view as text */
export interface RenderOptions {
  /** Max content length for assistant messages (default: 1200) */
  assistantMaxChars?: number;
  /** Max content length for user messages (default: 200) */
  userMaxChars?: number;
  /** Include full content for the last assistant message (for referential follow-ups) */
  fullLastAssistant?: boolean;
}

/**
 * Render a lens view as a conversation summary string.
 * Messages are formatted as "Role: content" with configurable truncation.
 */
export function renderConversationSummary(view: LensView, options?: RenderOptions): string {
  const parts: string[] = [];
  const assistantMax = options?.assistantMaxChars ?? 1200;
  const userMax = options?.userMaxChars ?? 200;

  if (view.messages.length > 0) {
    parts.push('Recent conversation:');
    const lastIndex = view.messages.length - 1;

    for (let i = 0; i < view.messages.length; i++) {
      const msg = view.messages[i];
      const role = formatRole(msg.role);
      const isLastAssistant = options?.fullLastAssistant && i === lastIndex && msg.role === 'assistant';
      const maxLen = isLastAssistant ? Infinity : msg.role === 'assistant' ? assistantMax : userMax;
      const content = msg.content.length > maxLen ? `${msg.content.substring(0, maxLen)}...` : msg.content;
      parts.push(`${role}: ${content}`);
    }
  }

  return parts.join('\n');
}

/**
 * Render a lens view as a minimal context string showing the last assistant message.
 * Typically used for router/classifier agents that need minimal context.
 */
export function renderRouterContext(view: LensView): string {
  if (view.messages.length === 0) return '';
  const last = view.messages[view.messages.length - 1];
  if (last.role !== 'assistant') return '';
  return `Last assistant message: ${last.content}`;
}

function formatRole(role: CtxMessage['role']): string {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
  }
}
