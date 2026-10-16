export const PREVIEW_FIXTURES = {
  heading: 'Good morning, Alex',
  subtitle: 'A focused workspace for exploring your project.',
  provider: 'Sample provider',
  exampleLabel: 'Example only',
  modes: [
    { id: 'assistant', label: 'Assistant' },
    { id: 'coding', label: 'Coding' },
    { id: 'meeting', label: 'Meeting' },
  ],
  projects: [
    { name: 'Northstar Web', detail: 'React · TypeScript', color: 'violet' },
    { name: 'Field Notes', detail: 'Python · FastAPI', color: 'blue' },
    { name: 'Quiet Hours', detail: 'Design system', color: 'amber' },
  ],
  activity: [
    { title: 'Reviewed the navigation flow', detail: 'Northstar Web · 12 min ago', status: 'Complete' },
    { title: 'Mapped API response types', detail: 'Field Notes · Yesterday', status: 'Saved' },
    { title: 'Captured meeting highlights', detail: 'Quiet Hours · Monday', status: 'Ready' },
  ],
  suggestions: [
    'Explain how this project is organized',
    'Find a reusable pattern in the code',
    'Summarize the latest project activity',
  ],
};
