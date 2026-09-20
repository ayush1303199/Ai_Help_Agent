export type ContextMode = 'direct' | 'langchain';

export interface ContextDocument {
  name: string;
  text: string;
}

export interface ContextProfile {
  name: string;
  context: string;
}

export function truncateContextText(text: string, maxChars: number) {
  if (!text) return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 24).trim()}…`;
}

export function resolveContext({
  mode,
  sessionDocuments,
  activeProfile,
  contextCharBudget,
  profileCharBudget,
}: {
  mode: ContextMode;
  sessionDocuments: ContextDocument[];
  activeProfile: ContextProfile | null;
  contextCharBudget: number;
  profileCharBudget: number;
}) {
  void mode;
  const sections: string[] = [];
  if (activeProfile?.context) {
    sections.push(`Trained profile: ${activeProfile.name}\n${truncateContextText(activeProfile.context, profileCharBudget / 2)}`);
  }
  if (sessionDocuments.length > 0) {
    const sessionText = sessionDocuments
      .map((doc) => `Document: ${doc.name}\n${truncateContextText(doc.text, Math.max(900, Math.floor(contextCharBudget / Math.max(sessionDocuments.length, 1))))}`)
      .join('\n\n');
    sections.push(sessionText);
  }
  return sections.join('\n\n');
}
