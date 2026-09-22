import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from './context.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

export async function askClaude(history) {
  const system = `${buildSystemPrompt()}\n\nSi decides que esta conversacion necesita pasar a una persona del equipo, empieza tu respuesta EXACTAMENTE con la etiqueta [HANDOFF] seguida del mensaje que le dirias al usuario.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    system,
    messages: history,
  });

  const block = response.content.find((b) => b.type === 'text');
  return block ? block.text.trim() : '';
}
