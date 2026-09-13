const technicalTerms = ['Java', 'Spring Boot', 'Spring Security', 'Hibernate', 'JPA', 'PHP', 'Yii2', 'React', 'MySQL', 'AWS', 'Docker', 'Kubernetes', 'Terraform', 'Jenkins', 'REST API', 'Microservices'];

export function voiceSafeText(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanTranscript(rawText: string) {
  let text = rawText.replace(/\s+/g, ' ').trim();
  text = text.replace(/^(um+|uh+|you know|like)\s+/i, '');
  for (const term of technicalTerms) {
    text = text.replace(new RegExp(`\\b${term.replace(/[+/]/g, '\\$&')}\\b`, 'gi'), term);
  }
  if (/^(what|why|how|when|where|who|can|could|would|is|are|do|does|explain|tell me)\b/i.test(text) && !/[.!?]$/.test(text)) {
    text += '?';
  }
  return text;
}

export function detectQuestion(text: string) {
  const question = text.trim();
  if (question.length < 3) return { isQuestion: false, question: null };
  if (/^(hi|hello|hey|okay|ok|thanks?|thank you|bye|goodbye)[.!?]?$/i.test(question)) {
    return { isQuestion: false, question: null };
  }
  const isQuestion = /[?]$/.test(question)
    || /^(what|why|how|when|where|who|can|could|would|is|are|do|does|explain|tell me|compare|describe)\b/i.test(question)
    || question.split(/\s+/).length >= 4;
  return { isQuestion, question: isQuestion ? question : null };
}
