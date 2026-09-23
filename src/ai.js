import Anthropic from '@anthropic-ai/sdk';

// Lead fields that are private research and must never be quoted back to the prospect.
const PRIVATE_FIELDS = ['monthlyPayEstimate', 'businessEmail', 'businessPhone', 'dateAdded', 'notes'];

function systemPrompt(c) {
  return [
    `You write first-contact Instagram DMs${c.senderName ? ` on behalf of ${c.senderName}` : ''}.`,
    c.offer ? `What the sender offers:\n${c.offer}` : '',
    `Tone: ${c.tone}.`,
    `Language: ${c.language}.`,
    `Rules:
- At most ${c.maxWords} words. Short lines, no walls of text.
- Open with something specific to THIS account (their content, niche, city, a real gap you can see in the research). Never generic praise.
- Sound like a person typing on their phone, not a marketer. No buzzwords, no "I hope this message finds you well".
- No links, no hashtags, no subject lines, no sign-off signature.
- End with one easy, low-pressure question.
- Never invent facts about the account beyond the research given. Never mention prices, pay estimates, or that you have "research" on them.
- Output ONLY the message text, nothing else.`,
    c.rules ? `Extra rules from the sender:\n${c.rules}` : '',
    c.example ? `Example of a DM the sender likes (match its style, not its wording):\n${c.example}` : '',
  ].filter(Boolean).join('\n\n');
}

function leadBlock(lead) {
  const data = { ...lead.data };
  for (const k of PRIVATE_FIELDS) delete data[k];
  const lines = Object.entries(data)
    .filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : v}`);
  return `Instagram account: @${lead.username}\n${lead.name ? `Name: ${lead.name}\n` : ''}Research:\n${lines.join('\n') || '(none)'}\n\nWrite the DM.`;
}

export async function writeDM(lead, settings) {
  const client = new Anthropic(settings.apiKey ? { apiKey: settings.apiKey } : {});
  const model = settings.model || 'claude-opus-5';
  const params = {
    model,
    max_tokens: 4000,
    system: [{ type: 'text', text: systemPrompt(settings.campaign), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: leadBlock(lead) }],
  };
  if (!model.startsWith('claude-haiku')) params.output_config = { effort: 'low' };
  // Opus 5 / Fable 5.1: if a safety classifier declines, retry on a fallback model server-side.
  if (model === 'claude-opus-5' || model.startsWith('claude-fable-5')) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const res = params.betas ? await client.beta.messages.create(params) : await client.messages.create(params);
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to write this message');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('Empty response from Claude');
  return text.replace(/^["“]|["”]$/g, '').trim();
}
