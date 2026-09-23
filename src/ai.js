/**
 * Applies the campaign script to a lead, substituting {{businessName}} with the lead's name.
 * No AI call — the message is exactly what the user wrote, with the name filled in.
 */
export function writeDM(lead, settings) {
  const script = settings.campaign.script || '';
  if (!script.trim()) throw new Error('Write your DM script in the Campaign tab first');
  const name = lead.name || lead.username;
  return script.replace(/\{\{businessName\}\}/gi, name).trim();
}
