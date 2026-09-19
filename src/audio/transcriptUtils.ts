const technicalTerms = [
  'ConcurrentHashMap',
  'Spring Boot',
  'Spring Security',
  'React.js',
  'TypeScript',
  'JavaScript',
  'WebSocket',
  'PostgreSQL',
  'MongoDB',
  'Microservices',
  'REST API',
  'GitHub Copilot',
  'Node.js',
  'FastAPI',
  'Kubernetes',
  'Hibernate',
  'Terraform',
  'Jenkins',
  'OpenAI',
  'Copilot',
  'Groq',
  'Docker',
  'GitHub',
  'MySQL',
  'AWS',
  'Azure',
  'Java',
  'JPA',
  'PHP',
  'Yii2',
  'React',
  'Python',
  'API',
  'SQL',
];

const technicalAliases: Array<[RegExp, string]> = [
  [/\bconcurrent\s+hash\s*map\b/gi, 'ConcurrentHashMap'],
  [/\bweb\s*socket\b/gi, 'WebSocket'],
];

export type InputQualityClassification =
  | 'ACCEPTED'
  | 'EMPTY'
  | 'FILLER'
  | 'REPEATED_NOISE'
  | 'INCOMPLETE'
  | 'NOT_A_QUESTION';

export interface PreparedQuestion {
  rawText: string;
  normalizedText: string;
  acceptedQuestion: string | null;
  qualityClassification: InputQualityClassification;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePunctuation(text: string) {
  return text
    .replace(/\s+([!?.,])/g, '$1')
    .replace(/([!?])\1+/g, '$1')
    .replace(/,{2,}/g, ',')
    .replace(/\.{4,}/g, '.');
}

function isFiller(text: string) {
  return /^(?:uh+|um+|hmm+|hm+|okay|ok|yes|no|right|sure|the|a|an)[.!?]*$/i.test(text);
}

function isIncomplete(text: string) {
  const withoutPunctuation = text.replace(/[.!?…]+$/g, '').trim();
  return /(?:\.\.\.|…)$/.test(text)
    || /(?:\b(?:what|why|how|when|where|who|is|are|can|could|would|do|does|between|of|in|for|to|and|or|with|from|the|a|an|difference)\s*)$/i.test(withoutPunctuation)
    || /^(?:what|why|how|when|where|who|can|could|would|is|are|do|does|explain|tell me|compare|describe)\s*[.!?]*$/i.test(withoutPunctuation);
}

function isRepeatedNoise(text: string) {
  return /^(what|huh|sorry|yes|no)(?:[.!?]?\s+\1)+[.!?]*$/i.test(text);
}

function questionFingerprint(text: string) {
  return normalizePunctuation(text)
    .toLocaleLowerCase()
    .replace(/[.!?…]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function voiceSafeText(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanTranscript(rawText: string) {
  let text = normalizePunctuation(rawText.replace(/\s+/g, ' ').trim());
  text = text.replace(/^(um+|uh+|you know|like)\s+/i, '');
  for (const [pattern, term] of technicalAliases) {
    text = text.replace(pattern, term);
  }
  for (const term of [...technicalTerms].sort((left, right) => right.length - left.length)) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi'), term);
  }
  if (/^(what|why|how|when|where|who|can|could|would|is|are|do|does|explain|tell me|compare|describe)\b/i.test(text)) {
    if (/\.$/.test(text)) text = `${text.slice(0, -1)}?`;
    else if (!/[!?]$/.test(text)) text += '?';
  }
  return text;
}

export function prepareQuestion(rawText: string): PreparedQuestion {
  const raw = String(rawText || '');
  const normalized = cleanTranscript(raw);
  if (!normalized) {
    return { rawText: raw, normalizedText: normalized, acceptedQuestion: null, qualityClassification: 'EMPTY' };
  }
  if (isRepeatedNoise(normalized)) {
    return { rawText: raw, normalizedText: normalized, acceptedQuestion: null, qualityClassification: 'REPEATED_NOISE' };
  }
  if (isFiller(normalized)) {
    return { rawText: raw, normalizedText: normalized, acceptedQuestion: null, qualityClassification: 'FILLER' };
  }
  if (isIncomplete(normalized)) {
    return { rawText: raw, normalizedText: normalized, acceptedQuestion: null, qualityClassification: 'INCOMPLETE' };
  }
  const detected = detectQuestion(normalized);
  if (!detected.isQuestion || !detected.question) {
    return { rawText: raw, normalizedText: normalized, acceptedQuestion: null, qualityClassification: 'NOT_A_QUESTION' };
  }
  return {
    rawText: raw,
    normalizedText: normalized,
    acceptedQuestion: detected.question,
    qualityClassification: 'ACCEPTED',
  };
}

export function questionFingerprintForComparison(text: string) {
  return questionFingerprint(text);
}

export function joinQuestionContinuation(previous: string, current: string) {
  if (!isIncomplete(previous)) return null;
  const previousText = cleanTranscript(previous).replace(/[.!?…]+$/g, '').trim();
  const currentText = cleanTranscript(current);
  if (!previousText || !currentText || /^(what|why|how|when|where|who|can|could|would|is|are|do|does|explain|tell me|compare|describe)\b/i.test(currentText)) {
    return null;
  }
  if (!/(?:\b(?:between|of|in|for|to|and|or|with|from|the|a|an|difference)\s*)$/i.test(previousText)) {
    return null;
  }
  return cleanTranscript(`${previousText} ${currentText}`);
}

export function detectQuestion(text: string) {
  const question = normalizePunctuation(text.replace(/\s+/g, ' ').trim());
  if (question.length < 3) return { isQuestion: false, question: null };
  if (/^(hi|hello|hey|okay|ok|thanks?|thank you|bye|goodbye)[.!?]?$/i.test(question)) {
    return { isQuestion: false, question: null };
  }
  if (isRepeatedNoise(question) || isFiller(question) || isIncomplete(question)) {
    return { isQuestion: false, question: null };
  }
  const isQuestion = /[?]$/.test(question)
    || /^(what|why|how|when|where|who|can|could|would|is|are|do|does|explain|tell me|compare|describe)\b/i.test(question)
    || question.split(/\s+/).length >= 4;
  return { isQuestion, question: isQuestion ? question : null };
}
