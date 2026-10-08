import { Component } from 'react';
export default class ErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.error('Interface failure:', error.name);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="error-recovery" role="alert">
        <h1>Не удалось открыть экран</h1>
        <p>
          Произошёл сбой отображения. Обновите страницу. Если вы только что сохраняли изменения,
          проверьте результат в журнале действий.
        </p>
        <div className="row-actions">
          <button className="button primary" onClick={() => location.reload()}>
            Обновить страницу
          </button>
          <a className="button" href="/">
            На главную
          </a>
        </div>
      </main>
    );
  }
}
