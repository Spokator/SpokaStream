import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

const AUTO_RETRIES = 3;
const RETRY_MS = 800;

/**
 * Une erreur d'affichage retirait toute l'interface et laissait un fond vide. Le moteur, lui, vit hors de React :
 * le stream, le vocal et le salon continuent. On remonte donc l'interface sans recharger la page, ce qui couperait tout.
 */
export class CrashGuard extends Component<{ children: ReactNode; onCrash: (error: Error, stack: string) => void }, { crashes: number; failed: boolean }> {
  override state = { crashes: 0, failed: false };
  private timer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onCrash(error, info.componentStack ?? "");
    if (this.state.crashes >= AUTO_RETRIES) return;
    this.timer = setTimeout(() => this.retry(), RETRY_MS);
  }

  override componentWillUnmount() {
    clearTimeout(this.timer);
  }

  private retry = () => this.setState(state => ({ crashes: state.crashes + 1, failed: false }));

  override render() {
    if (!this.state.failed) return <div key={this.state.crashes} style={{ display: "contents" }}>{this.props.children}</div>;
    return (
      <main className="crash-guard" role="alert">
        <h1>L'affichage a eu un problème</h1>
        <p>{this.state.crashes >= AUTO_RETRIES ? "Ton stream et ton salon continuent. Relance l'affichage pour les retrouver." : "Il se relance tout seul. Ton stream continue."}</p>
        {this.state.crashes >= AUTO_RETRIES && (
          <button type="button" onClick={this.retry}>
            Relancer l'affichage
          </button>
        )}
      </main>
    );
  }
}
