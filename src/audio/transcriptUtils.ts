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

export interface TranscriptNormalizationContext {
  supportedTerms?: readonly string[];
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

function isRepeatedSentenceNoise(text: string) {
  const sentences = text
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim().toLocaleLowerCase())
    .filter(Boolean);
  return sentences.length >= 2
    && sentences.every((sentence) => sentence === sentences[0]);
}

function isIncomplete(text: string) {
  const withoutPunctuation = text.replace(/[.!?…]+$/g, '').trim();
  return /(?:\.\.\.|…)$/.test(text)
    || /(?:\b(?:what|why|how|when|where|who|is|are|can|could|would|do|does|between|of|in|for|to|and|or|with|from|the|a|an|difference)\s*)$/i.test(withoutPunctuation)
    || /^(?:what|why|how|when|where|who|can|could|would|is|are|do|does|explain|tell me|compare|describe)\s*[.!?]*$/i.test(withoutPunctuation);
}

function isRepeatedNoise(text: string) {
  return /^(what|huh|sorry|yes|no)(?:[.!?]?\s+\1)+[.!?]*$/i.test(text)
    || isRepeatedSentenceNoise(text);
}

function hasMeaningfulRequestContent(text: string) {
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'be', 'but', 'for', 'from', 'have', 'i', 'in',
    'is', 'it', 'me', 'of', 'on', 'or', 'the', 'this', 'to', 'with', 'you',
  ]);
  const words = text
    .replace(/[.!?]+$/g, '')
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const meaningfulWords = new Set(words.filter((word) => !stopWords.has(word)));
  return meaningfulWords.size >= 2;
}

function isDeclarativeStatement(text: string) {
  return /^(?:i\s+(?:am|will|can|would|have|have to|am going to|will be)|i['’](?:m|ll))\b/i.test(text);
}

const questionOpening = /^(?:what|why|how|when|where|who|which|can|could|would|is|are|do|does|explain|tell me|compare|describe|summarize|review|analyze|show me|help me|please\s+(?:tell me|explain|describe))\b/i;

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

function normalizedTermKey(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '');
}

function similarityScore(left: string, right: string) {
  const leftKey = normalizedTermKey(left);
  const rightKey = normalizedTermKey(right);
  if (!leftKey || !rightKey) return 0;
  if (leftKey === rightKey) return 1;

  const editDistance = (function computeDistance(a: string, b: string) {
    const rows = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let index = 0; index <= a.length; index += 1) rows[index][0] = index;
    for (let index = 0; index <= b.length; index += 1) rows[0][index] = index;
    for (let row = 1; row <= a.length; row += 1) {
      for (let column = 1; column <= b.length; column += 1) {
        const cost = a[row - 1] === b[column - 1] ? 0 : 1;
        rows[row][column] = Math.min(
          rows[row - 1][column] + 1,
          rows[row][column - 1] + 1,
          rows[row - 1][column - 1] + cost,
        );
      }
    }
    return rows[a.length][b.length];
  })(leftKey, rightKey);

  const maxLength = Math.max(leftKey.length, rightKey.length);
  const editBased = 1 - (editDistance / Math.max(maxLength, 1));
  const commonPrefix = (() => {
    let matched = 0;
    const limit = Math.min(leftKey.length, rightKey.length);
    while (matched < limit && leftKey[matched] === rightKey[matched]) matched += 1;
    return matched;
  })();
  const sharedSuffix = (() => {
    let matched = 0;
    const limit = Math.min(leftKey.length, rightKey.length);
    while (matched < limit && leftKey[leftKey.length - 1 - matched] === rightKey[rightKey.length - 1 - matched]) matched += 1;
    return matched;
  })();
  const tokenShapeBonus = (
    /(?:spring|string|board|boot|security|jpa|java|react|mysql|aws|docker|kubernetes|postgres)/i.test(leftKey)
      && /(?:spring|string|board|boot|security|jpa|java|react|mysql|aws|docker|kubernetes|postgres)/i.test(rightKey)
  ) ? 0.15 : 0;
  return Math.max(0, Math.min(1, (editBased * 0.65) + ((commonPrefix + sharedSuffix) / Math.max(maxLength * 2, 1) * 0.2) + tokenShapeBonus));
}

function phraseSimilarity(left: string, right: string) {
  const leftWords = left.trim().split(/\s+/).filter(Boolean);
  const rightWords = right.trim().split(/\s+/).filter(Boolean);
  if (!leftWords.length || !rightWords.length) return 0;

  let total = 0;
  for (const leftWord of leftWords) {
    let best = 0;
    for (const rightWord of rightWords) {
      best = Math.max(best, similarityScore(leftWord, rightWord));
    }
    total += best;
  }
  const averageTokenSimilarity = total / leftWords.length;
  const sharedDerivedTokens = leftWords.some((leftWord) => rightWords.some((rightWord) => (
    normalizedTermKey(leftWord).includes(normalizedTermKey(rightWord).slice(0, 3))
      || normalizedTermKey(rightWord).includes(normalizedTermKey(leftWord).slice(0, 3))
  ))) ? 0.12 : 0;
  return Math.max(0, Math.min(1, averageTokenSimilarity + sharedDerivedTokens));
}

function hasStrongTechnicalIntent(text: string) {
  const lowerText = text.toLocaleLowerCase();
  const technicalAnchor = /(dependency\s+(?:injection|injection)|tendency\s+injection|difference\s+between|java\s+and\s+spring|spring\s+boot|springboard|spring\s*board|string\s+board|spring\s+security|react\s+and|mysql|aws|docker|kubernetes|hibernate|jpa|microservices|rest\s+api)/i;
  return technicalAnchor.test(lowerText)
    && /\b(?:what|why|how|when|where|who|which|explain|describe|compare|tell me|show me|introduce|walk me through)\b/i.test(lowerText);
}

function applySpringBootContextCorrections(text: string, context?: TranscriptNormalizationContext) {
  const terms = [...new Set((context?.supportedTerms || []).filter((term) => term && term.trim()))];
  if (!terms.some((term) => /spring\s*boot/i.test(term))) return text;

  const lowerText = text.toLocaleLowerCase();
  if (!hasStrongTechnicalIntent(text)) return text;

  const hasDependencyInjectionPattern = /(dependency|tendency)\s+injection/i.test(lowerText);
  const hasSpringBootPhoneticPattern = /(?:springboard|spring\s*board|string\s+board)/i.test(lowerText);
  if (!hasDependencyInjectionPattern || !hasSpringBootPhoneticPattern) return text;

  let corrected = text
    .replace(/\bwhat\s+a\b/gi, 'what is')
    .replace(/\btendency\b/gi, 'dependency')
    .replace(/\b(?:spring|string)\s*board\b/gi, 'Spring Boot')
    .replace(/\bspringboard\b/gi, 'Spring Boot')
    .replace(/\bstring\s+board\b/gi, 'Spring Boot');

  corrected = corrected.replace(/\bwhat\s+is\s+the\s+dependency\s+injection\s+in\s+the\s+Spring Boot\?/i, 'What is the dependency injection in the Spring Boot?');
  corrected = corrected.replace(/\bwhat\s+is\s+dependency\s+injection\s+in\s+the\s+Spring Boot\?/i, 'What is dependency injection in the Spring Boot?');
  corrected = corrected.replace(/\bwhat\s+is\s+dependency\s+injection\s+in\s+the\s+Spring Boot\b/i, 'What is dependency injection in the Spring Boot?');
  corrected = corrected.replace(/\bwhat\s+is\s+the\s+dependency\s+injection\s+in\s+the\s+Spring Boot\b/i, 'What is the dependency injection in the Spring Boot?');

  if (/\bSpring Boot\b/i.test(corrected) && /\bdependency\s+injection\b/i.test(corrected)) {
    return corrected;
  }

  return text;
}

function correctContextSupportedTerms(text: string, context?: TranscriptNormalizationContext) {
  const terms = [...new Set((context?.supportedTerms || []).filter((term) => term && term.trim()))];
  if (!terms.length) return text;

  const correctedBySpringContext = applySpringBootContextCorrections(text, context);
  if (correctedBySpringContext !== text) return correctedBySpringContext;

  const lowerText = text.toLocaleLowerCase();
  const hasQuestionIntent = /\b(?:what|why|how|when|where|who|which|explain|describe|compare|tell me|show me|introduce|walk me through)\b/i.test(lowerText);
  const technicalAnchorPattern = /(dependency|injection|difference|between|java|spring|boot|security|react|mysql|aws|docker|kubernetes|hibernate|jpa|fastapi|django|postgres|sql|api|microservice)/i;
  if (!hasQuestionIntent || !technicalAnchorPattern.test(lowerText)) return text;

  const candidateChunks = new Set<string>();
  const rawParts = text.split(/\s+/);
  for (let index = 0; index < rawParts.length; index += 1) {
    for (let range = 1; range <= 3; range += 1) {
      const end = index + range;
      if (end > rawParts.length) continue;
      const chunk = rawParts.slice(index, end).join(' ');
      if (chunk.length > 2) candidateChunks.add(chunk);
    }
  }

  let bestMatch: { chunk: string; replacement: string; score: number } | null = null;
  for (const chunk of candidateChunks) {
    for (const term of terms) {
      const normalizedTerm = term.trim();
      if (!normalizedTerm || lowerText.includes(normalizedTerm.toLocaleLowerCase())) continue;
      const score = phraseSimilarity(chunk, normalizedTerm);
      if (score >= 0.72 && score <= 0.95 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { chunk, replacement: normalizedTerm, score };
      }
    }
  }

  if (!bestMatch) return text;
  return text.replace(new RegExp(`\\b${escapeRegExp(bestMatch.chunk)}\\b`, 'i'), bestMatch.replacement);
}

function normalizeTechnicalVocabulary(text: string, context?: TranscriptNormalizationContext) {
  let normalized = text;
  for (const [pattern, term] of technicalAliases) {
    normalized = normalized.replace(pattern, term);
  }
  for (const term of [...technicalTerms].sort((left, right) => right.length - left.length)) {
    normalized = normalized.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi'), term);
  }
  const corrected = correctContextSupportedTerms(normalized, context);
  return corrected === text ? normalized : corrected;
}

export function cleanTranscript(rawText: string, context?: TranscriptNormalizationContext) {
  let text = normalizePunctuation(rawText.replace(/\s+/g, ' ').trim());
  text = text.replace(/^(um+|uh+|you know|like)\s+/i, '');
  text = normalizeTechnicalVocabulary(text, context);
  if (/^(what|why|how|when|where|who|can|could|would|is|are|do|does|explain|tell me|compare|describe)\b/i.test(text)) {
    if (/\.$/.test(text)) text = `${text.slice(0, -1)}?`;
    else if (!/[!?]$/.test(text)) text += '?';
  }
  return text;
}

export function prepareQuestion(rawText: string, context?: TranscriptNormalizationContext): PreparedQuestion {
  const raw = String(rawText || '');
  const normalized = cleanTranscript(raw, context);
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
  if (detected.isQuestion && detected.question) {
    return {
      rawText: raw,
      normalizedText: normalized,
      acceptedQuestion: detected.question,
      qualityClassification: 'ACCEPTED',
    };
  }
  if (isDeclarativeStatement(normalized) || !hasMeaningfulRequestContent(normalized)) {
    return { rawText: raw, normalizedText: normalized, acceptedQuestion: null, qualityClassification: 'NOT_A_QUESTION' };
  }
  return {
    rawText: raw,
    normalizedText: normalized,
    acceptedQuestion: normalized,
    qualityClassification: 'ACCEPTED',
  };
}

export function prepareTextRequest(rawText: string, context?: TranscriptNormalizationContext): PreparedQuestion {
  const raw = String(rawText || '');
  const normalized = cleanTranscript(raw, context).trim();
  if (!normalized) {
    return { rawText: raw, normalizedText: normalized, acceptedQuestion: null, qualityClassification: 'EMPTY' };
  }
  if (isRepeatedNoise(normalized) || isFiller(normalized)) {
    return { rawText: raw, normalizedText: normalized, acceptedQuestion: null, qualityClassification: 'REPEATED_NOISE' };
  }
  const textRequestSignals = /^(?:introduce|tell me about|explain|describe|summarize|compare|review|analyze|show me|help me|what are|what is|why should|how should|why|how|what|when|where|who|which|can you|could you|please\s+tell me|please\s+explain|please\s+describe)/i;
  if (!textRequestSignals.test(normalized) && normalized.split(/\s+/).length < 4) {
    return { rawText: raw, normalizedText: normalized, acceptedQuestion: null, qualityClassification: 'NOT_A_QUESTION' };
  }
  return {
    rawText: raw,
    normalizedText: normalized,
    acceptedQuestion: normalized,
    qualityClassification: 'ACCEPTED',
  };
}

export function questionFingerprintForComparison(text: string) {
  return questionFingerprint(text);
}

export function joinQuestionContinuation(
  previous: string,
  current: string,
  context?: TranscriptNormalizationContext,
) {
  if (!isIncomplete(previous)) return null;
  const previousText = cleanTranscript(previous, context).replace(/[.!?…]+$/g, '').trim();
  const currentText = cleanTranscript(current, context);
  if (!previousText || !currentText || isIncomplete(currentText) || !hasMeaningfulRequestContent(currentText)) {
    return null;
  }
  return cleanTranscript(`${previousText} ${currentText}`, context);
}

export function detectQuestion(text: string) {
  const question = normalizePunctuation(text.replace(/\s+/g, ' ').trim());
  if (question.length < 3) return { isQuestion: false, question: null };
  if (/^(hi|hello|hey|okay|ok|thanks?|thank you|bye|goodbye)[.!?]?$/i.test(question)) {
    return { isQuestion: false, question: null };
  }
  if (/^(?:i\s+(?:am|will|can|would|have|have to|need to|am going to|will be)|i['’]m|i['’]ll)\b/i.test(question)) {
    return { isQuestion: false, question: null };
  }
  if (isRepeatedNoise(question) || isFiller(question) || isIncomplete(question)) {
    return { isQuestion: false, question: null };
  }
  const requestSignal = /^(?:introduce yourself|tell me about yourself|describe yourself|walk me through yourself|tell me about|explain|describe|summarize|compare|review|analyze|show me|help me)\b/i;
  const isQuestion = /[?]$/.test(question)
    || questionOpening.test(question)
    || requestSignal.test(question);
  return { isQuestion, question: isQuestion ? question : null };
}
