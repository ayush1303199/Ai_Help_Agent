export const INTERVIEW_CONTEXT_STORAGE_KEY = 'interview-context-v1';

export const INTERVIEW_DOMAIN_OPTIONS = [
  'Technical Interview',
  'Software Engineer',
  'Frontend Engineer',
  'Backend Engineer',
  'Full Stack Engineer',
  'Mobile Developer',
  'DevOps/SRE',
  'Cloud Architect/Engineer',
  'AI/ML Engineer',
  'Data Scientist',
  'Data Analyst',
  'QA/Testing Engineer',
  'Cyber Security Specialist',
  'System Design Expert',
  'Project Manager',
  'Project / Engineering Management',
  'Sales & Business Development',
  'Finance & Accounting',
  'HR/Behavioral',
  'Medical/Clinical',
  'General Interview',
  'Custom Prompt',
  'Planning & Scheduling Engineer',
] as const;

export const INTERVIEW_BACKGROUND_OPTIONS = [
  'All Technologies',
  'Swift (iOS)',
  'Kotlin (Android)',
  'Dart/Flutter',
  'Java',
  'Spring Boot',
  'Spring Security',
  'Hibernate',
  'JPA',
  'Microservices',
  'REST API',
  'React',
  'React.js',
  'JavaScript',
  'TypeScript',
  'HTML',
  'CSS',
  'Node.js',
  'PHP',
  'Yii2',
  'Python',
  'Django',
  'FastAPI',
  'C',
  'C++',
  'C#',
  '.NET',
  'MySQL',
  'PostgreSQL',
  'MongoDB',
  'Redis',
  'Oracle',
  'SQL',
  'AWS',
  'AWS EC2',
  'AWS S3',
  'AWS RDS',
  'AWS Lambda',
  'AWS ECS',
  'Docker',
  'Kubernetes',
  'Jenkins',
  'Git',
  'GitHub',
  'GitLab',
  'CI/CD',
  'Linux',
  'Terraform',
  'Ansible',
  'Kafka',
  'RabbitMQ',
  'GraphQL',
  'WebSocket',
  'Machine Learning',
  'TensorFlow',
  'PyTorch',
  'Spark',
  'Hadoop',
  'Power BI',
  'Tableau',
  'Other',
] as const;

export interface InterviewContextConfig {
  domain: string | null;
  background: string[];
  microphoneDeviceId: string | null;
}

export interface CanonicalInterviewContext {
  currentQuestion: string;
  hasCandidateContext: boolean;
  domain: string | null;
  background: string[];
  customPrompt?: string | null;
}

export function createCanonicalInterviewContext(
  input: Omit<CanonicalInterviewContext, 'background'> & { background?: readonly string[] },
): CanonicalInterviewContext {
  return {
    currentQuestion: input.currentQuestion.trim(),
    hasCandidateContext: Boolean(input.hasCandidateContext),
    domain: input.domain?.trim() || null,
    background: [...(input.background || [])].filter((item) => item.trim()),
    customPrompt: input.customPrompt?.trim() || null,
  };
}

export interface MicrophoneDeviceOption {
  deviceId: string;
  label: string;
  groupId?: string;
  isDefault?: boolean;
}

const LEGACY_DOMAIN_ALIASES: Record<string, typeof INTERVIEW_DOMAIN_OPTIONS[number]> = {
  'Software Engineering': 'Software Engineer',
  'Frontend Development': 'Frontend Engineer',
  'Backend Development': 'Backend Engineer',
  'Full Stack Development': 'Full Stack Engineer',
  'Mobile Development': 'Mobile Developer',
  DevOps: 'DevOps/SRE',
  'Cloud Engineering': 'Cloud Architect/Engineer',
  'AWS Cloud': 'Cloud Architect/Engineer',
  'AI / Machine Learning': 'AI/ML Engineer',
  'Data Engineering': 'Data Scientist',
  'Data Science': 'Data Scientist',
  'QA / Test Automation': 'QA/Testing Engineer',
  Cybersecurity: 'Cyber Security Specialist',
  'Project Management': 'Project Manager',
  'HR / Recruitment': 'HR/Behavioral',
  Finance: 'Finance & Accounting',
  Accounting: 'Finance & Accounting',
  Sales: 'Sales & Business Development',
  Other: 'General Interview',
};

function validDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (INTERVIEW_DOMAIN_OPTIONS.includes(value as typeof INTERVIEW_DOMAIN_OPTIONS[number])) return value;
  return LEGACY_DOMAIN_ALIASES[value] || null;
}

function validBackground(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => (
    typeof item === 'string'
    && INTERVIEW_BACKGROUND_OPTIONS.includes(item as typeof INTERVIEW_BACKGROUND_OPTIONS[number])
  )))];
}

export function normalizeInterviewContext(value: unknown): InterviewContextConfig {
  if (!value || typeof value !== 'object') return { domain: null, background: [], microphoneDeviceId: null };
  const candidate = value as { domain?: unknown; background?: unknown; microphoneDeviceId?: unknown };
  return {
    domain: validDomain(candidate.domain),
    background: validBackground(candidate.background),
    microphoneDeviceId: typeof candidate.microphoneDeviceId === 'string' && candidate.microphoneDeviceId.trim()
      ? candidate.microphoneDeviceId
      : null,
  };
}

export function readPersistedInterviewContext(): InterviewContextConfig {
  try {
    return normalizeInterviewContext(JSON.parse(localStorage.getItem(INTERVIEW_CONTEXT_STORAGE_KEY) || 'null'));
  } catch {
    return { domain: null, background: [], microphoneDeviceId: null };
  }
}

export function writePersistedInterviewContext(config: InterviewContextConfig) {
  try {
    localStorage.setItem(INTERVIEW_CONTEXT_STORAGE_KEY, JSON.stringify(normalizeInterviewContext(config)));
  } catch {
    // Keep the live selection when browser storage is unavailable.
  }
}

function normalizedMicrophoneLabel(label: string) {
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function microphoneLabelVariants(device: MicrophoneDeviceOption) {
  const normalized = normalizedMicrophoneLabel(device.label);
  if (!normalized) return [];
  const variants = new Set([normalized]);
  const defaultPrefix = normalized.replace(/^(?:default|communications)(?:\s+microphone)?\s*[-:]?\s*/i, '');
  if (defaultPrefix && defaultPrefix !== normalized) variants.add(defaultPrefix);
  const parenthetical = normalized.match(/\(([^()]+)\)\s*$/);
  if (parenthetical?.[1]) variants.add(parenthetical[1].trim());
  return [...variants];
}

function isDefaultMicrophone(device: MicrophoneDeviceOption) {
  return device.isDefault === true || device.deviceId === 'default' || device.deviceId === 'communications';
}

function defaultRepresentsDevice(defaultDevice: MicrophoneDeviceOption, candidate: MicrophoneDeviceOption) {
  if (defaultDevice.groupId && candidate.groupId && defaultDevice.groupId === candidate.groupId) return true;
  const defaultVariants = microphoneLabelVariants(defaultDevice);
  const candidateVariants = microphoneLabelVariants(candidate);
  return defaultVariants.some((variant) => candidateVariants.includes(variant));
}

function sameMicrophoneDevice(left: MicrophoneDeviceOption, right: MicrophoneDeviceOption) {
  if (left.deviceId === right.deviceId) return true;
  if (left.groupId && right.groupId && left.groupId === right.groupId) return true;
  return isDefaultMicrophone(left) && isDefaultMicrophone(right)
    && defaultRepresentsDevice(left, right);
}

/**
 * Convert browser/Electron audio-input records into the one selectable list
 * used by Context and the Meeting Assistant. Chromium can expose a `default`
 * pseudo-device alongside its physical input; when its group or label resolves
 * to a physical input, keep only the physical device ID for capture.
 */
export function normalizeMicrophoneDevices(devices: MicrophoneDeviceOption[]) {
  const byDeviceId = new Map<string, MicrophoneDeviceOption>();
  for (const device of devices) {
    const deviceId = device.deviceId.trim();
    if (!deviceId) continue;
    const next: MicrophoneDeviceOption = {
      deviceId,
      label: device.label.trim(),
      groupId: device.groupId?.trim() || undefined,
      isDefault: device.isDefault === true || deviceId === 'default' || deviceId === 'communications',
    };
    const existing = byDeviceId.get(deviceId);
    byDeviceId.set(deviceId, existing
      ? {
        ...existing,
        label: existing.label || next.label,
        groupId: existing.groupId || next.groupId,
        isDefault: existing.isDefault || next.isDefault,
      }
      : next);
  }

  const uniqueDevices = [...byDeviceId.values()];
  const physicalDevices = uniqueDevices.filter((device) => !isDefaultMicrophone(device));
  const defaultDevices = uniqueDevices.filter(isDefaultMicrophone);
  const resolvedPseudoDeviceIds = new Set(
    defaultDevices
      .filter((defaultDevice) => physicalDevices.some((candidate) => defaultRepresentsDevice(defaultDevice, candidate)))
      .map((defaultDevice) => defaultDevice.deviceId),
  );
  const resolvedDefaultIds = new Set(
    defaultDevices
      .flatMap((defaultDevice) => physicalDevices
        .filter((candidate) => defaultRepresentsDevice(defaultDevice, candidate))
        .map((candidate) => candidate.deviceId)),
  );
  const withoutResolvedPseudoDevices = uniqueDevices.filter((device) => !resolvedPseudoDeviceIds.has(device.deviceId));

  const normalized: MicrophoneDeviceOption[] = [];
  for (const device of withoutResolvedPseudoDevices) {
    const resolvedPhysicalDefault = resolvedDefaultIds.has(device.deviceId);
    const existing = normalized.find((candidate) => sameMicrophoneDevice(candidate, device));
    if (existing) {
      existing.label = existing.label || device.label;
      existing.groupId = existing.groupId || device.groupId;
      existing.isDefault = existing.isDefault || device.isDefault || resolvedPhysicalDefault;
      continue;
    }
    normalized.push({
      ...device,
      isDefault: Boolean(device.isDefault || resolvedPhysicalDefault),
    });
  }

  return normalized.sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)));
}

export function chooseMicrophoneDevice(
  devices: MicrophoneDeviceOption[],
  savedDeviceId: string | null,
) {
  const available = normalizeMicrophoneDevices(devices).filter((device) => device.deviceId);
  if (!available.length) return null;
  if (savedDeviceId && available.some((device) => device.deviceId === savedDeviceId)) return savedDeviceId;
  const namedDefault = available.find((device) => /AB13X USB Audio/i.test(device.label));
  if (namedDefault) return namedDefault.deviceId;
  const resolvedDefault = available.find((device) => device.isDefault);
  if (resolvedDefault) return resolvedDefault.deviceId;
  return available.find((device) => device.deviceId === 'default')?.deviceId
    || available[0].deviceId;
}

export function microphoneDisplayLabel(device: MicrophoneDeviceOption | null) {
  if (!device) return 'Microphone unavailable';
  if (/AB13X USB Audio/i.test(device.label)) return 'Default Microphone (AB13X USB Audio)';
  return device.label.trim() || (device.deviceId === 'default' ? 'Default Microphone' : 'Microphone');
}
