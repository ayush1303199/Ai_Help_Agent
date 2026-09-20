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

export interface MicrophoneDeviceOption {
  deviceId: string;
  label: string;
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

export function chooseMicrophoneDevice(
  devices: MicrophoneDeviceOption[],
  savedDeviceId: string | null,
) {
  const available = devices.filter((device) => device.deviceId);
  if (!available.length) return null;
  if (savedDeviceId && available.some((device) => device.deviceId === savedDeviceId)) return savedDeviceId;
  const namedDefault = available.find((device) => /AB13X USB Audio/i.test(device.label));
  return namedDefault?.deviceId
    || available.find((device) => device.deviceId === 'default')?.deviceId
    || available[0].deviceId;
}

export function microphoneDisplayLabel(device: MicrophoneDeviceOption | null) {
  if (!device) return 'Microphone unavailable';
  if (/AB13X USB Audio/i.test(device.label)) return 'Default Microphone (AB13X USB Audio)';
  return device.label.trim() || (device.deviceId === 'default' ? 'Default Microphone' : 'Microphone');
}
