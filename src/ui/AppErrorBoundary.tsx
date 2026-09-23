import { Component, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
  overlay?: boolean;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[UI] Unhandled renderer error', error, info.componentStack);
  }

  private recover = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className={this.props.overlay ? 'overlay-error-state' : 'app-error-state'} role="alert">
        <h1>AI Help Agent needs to recover</h1>
        <p>The interface hit an unexpected error. Your saved settings and conversation history are preserved.</p>
        <button type="button" onClick={this.recover}>Try again</button>
        <button type="button" onClick={() => window.location.reload()}>Reload app</button>
      </main>
    );
  }
}
