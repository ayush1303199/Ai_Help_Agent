import { useState } from 'react';

type PreviewFixtures = {
  heading: string;
  subtitle: string;
  provider: string;
  exampleLabel: string;
  modes: { id: string; label: string }[];
  projects: { name: string; detail: string; color: string }[];
  activity: { title: string; detail: string; status: string }[];
  suggestions: string[];
};

type PreviewAppProps = { fixtures: PreviewFixtures };

export function PreviewApp({ fixtures }: PreviewAppProps) {
  const [mode, setMode] = useState(fixtures.modes[0]?.id ?? '');

  return (
    <main className="preview-shell">
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="AI Help Agent preview home">
          <span className="brand-mark">A</span>
          <span>AI Help Agent</span>
        </a>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="mode-list" aria-label="Preview modes">
          {fixtures.modes.map((item) => (
            <button
              className={`mode-item${mode === item.id ? ' is-active' : ''}`}
              key={item.id}
              type="button"
              aria-pressed={mode === item.id}
              onClick={() => setMode(item.id)}
            >
              <span className={`mode-dot mode-dot-${item.id}`} />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-label"><span className="connection-dot" /> Preview mode</div>
          <div className="profile-row">
            <span className="avatar">A</span>
            <span><strong>Alex Morgan</strong><small>Personal workspace</small></span>
            <span className="profile-more">···</span>
          </div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> Overview</div>
          <div className="provider-pill"><span className="provider-dot" />{fixtures.provider}</div>
        </header>

        <div className="page-content">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">YOUR WORKSPACE</div>
              <h1>{fixtures.heading}</h1>
              <p className="subtitle">{fixtures.subtitle}</p>
            </div>
            <div className="date-pill"><span className="calendar-icon">▦</span> Tuesday, March 18</div>
          </div>

          <div className="preview-notice" role="note">
            <span className="notice-icon">i</span>
            <span>Preview — sample data, no services connected</span>
            <span className="notice-tag">LOCAL PREVIEW</span>
          </div>

          <div className="section-heading">
            <div><h2>Your projects</h2><p>Pick up where you left off.</p></div>
            <button className="text-button" type="button" disabled>View all <span>→</span></button>
          </div>
          <div className="project-grid">
            {fixtures.projects.map((project) => (
              <article className="project-card" key={project.name}>
                <div className={`project-icon project-icon-${project.color}`}>{project.name.slice(0, 1)}</div>
                <div className="project-menu">···</div>
                <h3>{project.name}</h3>
                <p>{project.detail}</p>
                <div className="project-footer"><span className="project-presence" /> Updated recently</div>
              </article>
            ))}
          </div>

          <div className="lower-grid">
            <section className="activity-panel">
              <div className="section-heading compact">
                <div><h2>Recent activity</h2><p>A little context goes a long way.</p></div>
                <button className="icon-button" type="button" disabled aria-label="More activity options">···</button>
              </div>
              <div className="activity-list">
                {fixtures.activity.map((item, index) => (
                  <article className="activity-item" key={item.title}>
                    <span className={`activity-marker activity-marker-${index + 1}`} />
                    <div className="activity-copy"><strong>{item.title}</strong><small>{item.detail}</small></div>
                    <span className="activity-status">{item.status}</span>
                  </article>
                ))}
              </div>
            </section>

            <section className="prompt-panel">
              <div className="prompt-orb">✳</div>
              <div className="eyebrow">A GOOD PLACE TO START</div>
              <h2>What would you like to explore?</h2>
              <p>These example prompts show the kind of help available in a connected workspace.</p>
              <div className="suggestion-list">
                {fixtures.suggestions.map((suggestion) => (
                  <div className="suggestion" key={suggestion}>
                    <span>{suggestion}</span><span className="suggestion-arrow">↗</span>
                  </div>
                ))}
              </div>
              <button className="composer" type="button" disabled>
                <span>Ask a question about your project...</span><span className="composer-send">↑</span>
              </button>
              <small className="example-label">{fixtures.exampleLabel}</small>
            </section>
          </div>
        </div>
      </section>
    </main>
  );
}
