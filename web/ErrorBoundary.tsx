import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A render error in one panel must not leave the demo as a blank page.
 *
 * The console is a public artifact; if a state edge case throws, the viewer
 * should still see what happened and be able to reset, instead of a white
 * screen with no clue. The message is shown, not swallowed.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('console render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app">
          <header className="masthead">
            <div>
              <p className="eyebrow">sns-shortform-automation</p>
              <h1>화면을 그리는 중 오류가 났습니다</h1>
              <p>
                입력값에서 엔진이 거부한 값이 있었습니다. 아래 메시지를 확인하고 처음 상태로 돌아가세요. 대본·자막은
                저장되지 않으므로 이 화면에서 잃는 데이터는 없습니다.
              </p>
            </div>
          </header>
          <pre className="prompt-box" style={{ margin: '0 24px' }}>
            {this.state.error.name}: {this.state.error.message}
          </pre>
          <div style={{ padding: 24 }}>
            <button type="button" className="btn primary" onClick={() => this.setState({ error: null })}>
              다시 그리기
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
